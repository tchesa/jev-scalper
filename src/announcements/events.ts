/**
 * Build the event list: announcements that concern a tracked meme contract, with the measured price reaction.
 *
 *   pnpm ann:events [--cache data/announcements] [--vision data/binance-vision] [--out data/announcements/events.json]
 *
 * Candidates: title mentions a tracked base asset, or the title is a batch notice (leverage, margin, funding,
 * delisting, risk tag) whose body may list many symbols. Details are fetched only for candidates.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getExchangeInfo } from "../binance/rest.js";
import { logger } from "../log.js";
import { fetchDetail, type ListedArticle } from "./fetch.js";
import { eventKind, matchAssets, type EventKind, type TrackedAsset } from "./match.js";
import { reactionFor, type Reaction } from "./reaction.js";

const log = logger("events");

export interface AnnEvent {
  code: string;
  title: string;
  text: string;
  catalog: string | null;
  publishedAt: number;
  base: string;
  perp: string;
  spot: string | null;
  perpOnboard: number;
  kind: EventKind;
  assetsInNotice: number; // how many tracked assets the same notice mentions
  reaction: Reaction | null;
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
}

export async function trackedAssets(): Promise<TrackedAsset[]> {
  const info = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo").then((r) => r.json()) as { symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string; contractType: string; onboardDate: number; underlyingSubType?: string[] }> };
  const spot = await fetch("https://api.binance.com/api/v3/exchangeInfo").then((r) => r.json()) as { symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string }> };
  const spotBases = new Set(spot.symbols.filter((s) => s.quoteAsset === "USDT").map((s) => s.baseAsset));
  return info.symbols
    .filter((s) => s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && (s.underlyingSubType ?? []).some((t) => /meme/i.test(t)))
    .map((s) => {
      const base = s.baseAsset.replace(/^(1000000|1000|1M)(?=[A-Z])/, "");
      return { base, perp: s.symbol, spot: spotBases.has(base) ? `${base}USDT` : null, perpOnboard: s.onboardDate };
    });
}

const BATCH = /leverage|margin|funding|delist|removal|monitoring tag|seed tag|position limit|settlement|notional|trading pairs|perpetual contracts/i;

async function main(): Promise<void> {
  const cache = arg("cache", "data/announcements");
  const vision = arg("vision", "data/binance-vision");
  const out = arg("out", `${cache}/events.json`);
  const index = JSON.parse(readFileSync(`${cache}/index.json`, "utf8")) as ListedArticle[];
  const assets = await trackedAssets();
  log.info("loaded", { articles: index.length, assets: assets.length });

  const candidates = index.filter((a) => matchAssets(a, assets).length > 0 || BATCH.test(a.title));
  log.info("candidates", { byTitleOrBatch: candidates.length });

  const events: AnnEvent[] = [];
  let fetched = 0;
  for (const a of candidates) {
    const d = await fetchDetail(a, cache);
    fetched++;
    if (fetched % 100 === 0) log.info("details", { fetched, of: candidates.length, events: events.length });
    const hits = matchAssets(d, assets);
    for (const asset of hits) {
      events.push({
        code: d.code,
        title: d.title,
        text: d.text,
        catalog: d.firstCatalogName,
        publishedAt: d.releaseDate,
        base: asset.base,
        perp: asset.perp,
        spot: asset.spot,
        perpOnboard: asset.perpOnboard,
        kind: eventKind(d.title),
        assetsInNotice: hits.length,
        reaction: null,
      });
    }
  }
  log.info("matched", { events: events.length, notices: new Set(events.map((e) => e.code)).size });

  let measured = 0;
  for (const e of events) {
    try {
      e.reaction = await reactionFor(e, e.publishedAt, vision);
      if (e.reaction) measured++;
    } catch (err) {
      log.warn("reaction failed", { code: e.code, base: e.base, err });
    }
  }
  events.sort((a, b) => a.publishedAt - b.publishedAt);
  writeFileSync(out, JSON.stringify(events));
  const byKind: Record<string, number> = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  log.info("done", { events: events.length, measured, out, byKind });
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
