/**
 * Live forward test, no trading: poll the announcement feed, ask Jev the moment a new notice appears,
 * store the answer with the time the poller first saw it. `pnpm ann:label` later measures the reaction.
 *
 *   pnpm ann:poll [--db data/announcements-live.sqlite] [--interval 5] [--universe all|meme] [--anonymize true]
 *
 * The list endpoints sit behind CloudFront with a 120 s cache keyed on the exact URL, including parameter
 * order. Polling one fixed URL therefore sees a notice up to two minutes late. The poller cycles through
 * parameter orderings and page sizes so every request is a fresh origin fetch: the new-listings catalog
 * (48) on every tick, the all-catalog endpoint on every other tick. Cache status and feed lag are recorded.
 * Every 30 minutes it also labels events older than 25 h from REST bars, so one process does everything.
 */
import { randomUUID } from "node:crypto";
import { TypeSafeClient, type ChoiceResponse, type NoulResponse } from "@typesafe-ai/sdk";
import { loadConfig } from "../config.js";
import { logger, setLogLevel } from "../log.js";
import { anonymizeText } from "./anonymize.js";
import { fetchDetail, type ListedArticle } from "./fetch.js";
import { labelDue } from "./label.js";
import { AnnLedger } from "./ledger.js";
import { eventKind, matchAssets, type TrackedAsset } from "./match.js";
import { ANN_QUESTION_VERSION, annQuestions, type AnnState, type Impact } from "./question.js";

const log = logger("poll");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const APEX = "https://www.binance.com/bapi/apex/v1/public/apex/cms/article/list/query?";
const COMPOSITE = "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?";

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

/** Distinct URLs that CloudFront caches separately but the origin answers identically. */
export function urlVariants(): { listings: string[]; all: string[] } {
  const listings: string[] = [];
  for (const size of [5, 10, 20]) for (const order of permutations(["type=1", "pageNo=1", `pageSize=${size}`, "catalogId=48"])) listings.push(COMPOSITE + order.join("&"));
  const all: string[] = [];
  for (const size of [5, 10]) for (const order of permutations(["type=1", "pageNo=1", `pageSize=${size}`])) all.push(APEX + order.join("&"));
  return { listings, all };
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function universe(kind: "all" | "meme"): Promise<TrackedAsset[]> {
  const info = (await (await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo")).json()) as { symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string; contractType: string; status: string; onboardDate: number; underlyingSubType?: string[] }> };
  const spot = (await (await fetch("https://api.binance.com/api/v3/exchangeInfo")).json()) as { symbols: Array<{ baseAsset: string; quoteAsset: string }> };
  const spotBases = new Set(spot.symbols.filter((s) => s.quoteAsset === "USDT").map((s) => s.baseAsset));
  return info.symbols
    .filter((s) => s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && s.status === "TRADING")
    .map((s) => {
      const base = s.baseAsset.replace(/^(1000000|1000|1M)(?=[A-Z])/, "");
      const meme = (s.underlyingSubType ?? []).some((t) => /meme/i.test(t));
      // Short names (NEWT, BANK, PUMP, ...) only count in pair or "(TOKEN)" form, whatever their group; a quiz
      // or campaign notice that uses the word in prose is not an event.
      return { base, perp: s.symbol, spot: spotBases.has(base) ? `${base}USDT` : null, perpOnboard: s.onboardDate, group: meme ? "meme" : "other", strict: base.length <= 4 };
    })
    .filter((a) => kind === "all" || a.group === "meme");
}

async function main(): Promise<void> {
  const cfg = loadConfig({ ...process.env, MODELS: "jev" });
  setLogLevel(cfg.logLevel);
  const intervalMs = Number(arg("interval", "5")) * 1000;
  const anonymize = arg("anonymize", "true") !== "false";
  const uni = arg("universe", "all") as "all" | "meme";
  const cacheDir = arg("cache", "data/announcements");
  const ledger = new AnnLedger(arg("db", "data/announcements-live.sqlite"));
  const client = new TypeSafeClient({ apiKey: cfg.typesafe.apiKey!, defaultModel: cfg.typesafe.model, timeout: 15_000, retry: { maxRetries: 1 } });
  const questions = annQuestions(2 * cfg.costs.takerFeeBps + 2 * cfg.costs.slippageBpsPerSide);
  const insertEvent = ledger.db.prepare(
    `INSERT OR IGNORE INTO ann_events (code, base, published_at, kind, grp, catalog, title, market, state_json, seen_at, perp, spot, perp_onboard) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  );
  const getId = ledger.db.prepare("SELECT id FROM ann_events WHERE code = ? AND base = ?");
  const insertDecision = ledger.db.prepare(
    `INSERT OR REPLACE INTO ann_decisions (event_id, model, question_version, anonymized, ts, latency_ms, event_choice, p_h1_up, p_h1_down, p_h1_flat, p_h24_up, p_h24_down, p_h24_flat, novelty, answers_json, input_tokens, error) VALUES (?, 'jev', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let assets = await universe(uni);
  let assetsAt = Date.now();
  let labelAt = 0;
  const seen = new Set<string>();
  const variants = urlVariants();
  let vi = 0;
  let tick = 0;
  const stats = { polls: 0, hits: 0, misses: 0, errors: 0, notices: 0, lagMs: [] as number[] };
  let statsAt = Date.now();
  // Prime with what is already published so only genuinely new notices trigger calls.
  // Prime from the largest page sizes so nothing the variants can return later looks new.
  for (const url of [variants.all[variants.all.length - 1]!, variants.listings[variants.listings.length - 1]!]) {
    const prime = (await (await fetch(url, { headers: { "User-Agent": UA } })).json()) as { data: { catalogs: Array<{ catalogId: number; articles: ListedArticle[] }> } };
    for (const c of prime.data.catalogs) for (const a of c.articles) seen.add(a.code);
  }
  log.info("polling", { runId: randomUUID(), intervalMs, universe: uni, assets: assets.length, primed: seen.size, anonymize, urlVariants: variants.listings.length + variants.all.length });

  for (;;) {
    const t0 = Date.now();
    tick++;
    try {
      if (t0 - assetsAt > 6 * 3_600_000) {
        assets = await universe(uni);
        assetsAt = t0;
      }
      if (t0 - labelAt > 30 * 60_000) {
        labelAt = t0;
        await labelDue(ledger).catch((err) => log.warn("labeling failed", err));
      }
      // Listings catalog every tick, everything else every other tick; always a URL CloudFront has not cached.
      const pool = tick % 2 === 0 ? variants.all : variants.listings;
      const url = pool[vi++ % pool.length]!;
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      stats.polls++;
      if (res.status === 429) {
        stats.errors++;
        log.warn("throttled");
        await sleep(30_000);
        continue;
      }
      if (/Hit/.test(res.headers.get("x-cache") ?? "")) stats.hits++;
      else stats.misses++;
      const data = (await res.json()) as { data: { catalogs: Array<{ catalogId: number; catalogName: string; articles: ListedArticle[] }> } };
      if (Date.now() - statsAt > 10 * 60_000) {
        const lag = [...stats.lagMs].sort((a, b) => a - b);
        log.info("stats 10 min", { polls: stats.polls, cacheHits: stats.hits, misses: stats.misses, errors: stats.errors, notices: stats.notices, lagMedianMs: lag.length ? lag[Math.floor(lag.length / 2)] : null });
        Object.assign(stats, { polls: 0, hits: 0, misses: 0, errors: 0, notices: 0, lagMs: [] });
        statsAt = Date.now();
      }
      for (const c of data.data.catalogs) {
        for (const a of c.articles) {
          if (seen.has(a.code)) continue;
          seen.add(a.code);
          const seenAt = Date.now();
          // A first sighting of something published hours ago is a deeper page, not a live notice.
          if (seenAt - a.releaseDate > 2 * 3_600_000) {
            log.debug("old article first seen, ignored", { code: a.code, ageMin: Math.round((seenAt - a.releaseDate) / 60_000) });
            continue;
          }
          stats.notices++;
          stats.lagMs.push(seenAt - a.releaseDate);
          const listed: ListedArticle = { ...a, catalogId: c.catalogId };
          const d = await fetchDetail(listed, cacheDir, 0);
          const hits = matchAssets(d, assets);
          log.info("new notice", { code: a.code, lagMs: seenAt - a.releaseDate, cache: res.headers.get("x-cache"), title: a.title.slice(0, 90), hits: hits.map((h) => h.base) });
          for (const asset of hits) {
            const text = d.text.length > 4000 ? `${d.text.slice(0, 4000)}\n[truncated]` : d.text;
            const listedBefore = asset.perpOnboard > 0 && asset.perpOnboard < a.releaseDate;
            const state: AnnState = {
              notice: { category: d.firstCatalogName, title: anonymize ? anonymizeText(d.title, asset.base, asset.perp, asset.spot) : d.title, text: anonymize ? anonymizeText(text, asset.base, asset.perp, asset.spot) : text },
              asset: { token: anonymize ? "TOKEN" : asset.base, hasPerpetual: listedBefore, hasSpot: Boolean(asset.spot), perpListedDaysAgo: listedBefore ? Math.round((a.releaseDate - asset.perpOnboard) / 86_400_000) : null },
            };
            insertEvent.run(a.code, asset.base, a.releaseDate, eventKind(d.title), asset.group ?? "other", d.firstCatalogName, d.title, JSON.stringify(state), seenAt, asset.perp, asset.spot, asset.perpOnboard);
            const eventId = (getId.get(a.code, asset.base) as { id: number }).id;
            let error: string | null = null;
            try {
              const tq = performance.now();
              const r = await client.systemOne({ state: state as unknown as Record<string, never>, questions });
              const ans = r.answers as unknown as { event: ChoiceResponse; h1: ChoiceResponse; h24: ChoiceResponse; novelty: NoulResponse };
              const h1 = ans.h1.probabilities as Record<Impact, number>;
              const h24 = ans.h24.probabilities as Record<Impact, number>;
              insertDecision.run(eventId, ANN_QUESTION_VERSION, anonymize ? 1 : 0, Date.now(), Math.round(performance.now() - tq), ans.event.choice, h1.up, h1.down, h1.flat, h24.up, h24.down, h24.flat, ans.novelty.noul, JSON.stringify({ event: ans.event.choice, h1, h24, novelty: ans.novelty.noul }), r.usage.input_tokens, null);
              log.info("jev", { base: asset.base, event: ans.event.choice, pUp1h: h1.up, pDown1h: h1.down, novelty: ans.novelty.noul, sinceSeenMs: Date.now() - seenAt });
            } catch (err) {
              error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
              insertDecision.run(eventId, ANN_QUESTION_VERSION, anonymize ? 1 : 0, Date.now(), null, null, null, null, null, null, null, null, null, null, null, error);
              log.warn("jev failed", { base: asset.base, error });
            }
          }
        }
      }
    } catch (err) {
      log.warn("poll error", err);
    }
    await sleep(Math.max(500, intervalMs - (Date.now() - t0)));
  }
}

// Run only when invoked directly, so tests can import urlVariants without starting a poller.
if (process.argv[1] && /poll\.ts$|poll\.js$/.test(process.argv[1])) {
  main().catch((err) => {
    log.error("fatal", err);
    process.exit(1);
  });
}
