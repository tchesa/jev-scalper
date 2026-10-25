/**
 * Ask Jev (and the baselines) about every measured announcement event, and store answers next to the labels.
 *
 *   pnpm ann:run [--events data/announcements/events.json] [--db data/announcements.sqlite]
 *                [--models jev,mock,random] [--anonymize true|false] [--concurrency 6] [--limit N]
 *                [--skip-existing true]   # do not re-ask a model about an event it already answered
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { TypeSafeClient, type ChoiceResponse, type NoulResponse } from "@typesafe-ai/sdk";
import { loadConfig } from "../config.js";
import { logger, setLogLevel } from "../log.js";
import { anonymizeText } from "./anonymize.js";
import type { AnnEvent } from "./events.js";
import { AnnLedger } from "./ledger.js";
import { ANN_QUESTION_VERSION, annQuestions, EVENT_LABELS, H1_PCT, H24_PCT, impactLabel, type AnnState, type Impact } from "./question.js";

const log = logger("ann-run");

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
}

interface Answers {
  event: string;
  h1: Record<Impact, number>;
  h24: Record<Impact, number>;
  novelty: number;
  latencyMs: number;
  inputTokens: number | null;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rule-based baseline from the title-derived event kind: listings up, delistings down, the rest flat-heavy. */
function mockAnswer(e: AnnEvent): Answers {
  const by: Record<string, [number, number, number]> = {
    futures_listing: [0.5, 0.15, 0.35],
    spot_listing: [0.5, 0.15, 0.35],
    alpha: [0.45, 0.15, 0.4],
    delisting: [0.1, 0.6, 0.3],
    risk_tag: [0.15, 0.45, 0.4],
    leverage_margin: [0.25, 0.25, 0.5],
    funding: [0.25, 0.25, 0.5],
    promotion: [0.3, 0.2, 0.5],
    other: [0.25, 0.25, 0.5],
  };
  const [u, d, f] = by[e.kind] ?? [0.25, 0.25, 0.5];
  const evMap: Record<string, string> = { futures_listing: "futures_listing", spot_listing: "spot_listing", delisting: "delisting", leverage_margin: "leverage_or_margin_change", funding: "funding_change", risk_tag: "risk_tag", promotion: "promotion_or_campaign", alpha: "product_or_other", other: "product_or_other" };
  return { event: e.assetsInNotice > 5 ? "passing_mention" : evMap[e.kind] ?? "product_or_other", h1: { up: u, down: d, flat: f }, h24: { up: u, down: d, flat: f }, novelty: 0.5, latencyMs: 0, inputTokens: null };
}

function randomAnswer(rnd: () => number): Answers {
  const draw = (): Record<Impact, number> => {
    const r = [0, 0, 0].map(() => -Math.log(rnd() || 1e-9));
    const s = r[0]! + r[1]! + r[2]!;
    return { up: r[0]! / s, down: r[1]! / s, flat: r[2]! / s };
  };
  return { event: EVENT_LABELS[Math.floor(rnd() * EVENT_LABELS.length)]!, h1: draw(), h24: draw(), novelty: rnd(), latencyMs: 0, inputTokens: null };
}

function buildState(e: AnnEvent, anonymize: boolean): AnnState {
  const text = e.text.length > 4000 ? `${e.text.slice(0, 4000)}\n[truncated]` : e.text;
  const token = anonymize ? "TOKEN" : e.base;
  const t = anonymize ? anonymizeText(text, e.base, e.perp, e.spot) : text;
  const title = anonymize ? anonymizeText(e.title, e.base, e.perp, e.spot) : e.title;
  const listedBefore = e.perpOnboard && e.perpOnboard < e.publishedAt;
  return {
    notice: { category: e.catalog, title, text: t },
    asset: { token, hasPerpetual: Boolean(listedBefore), hasSpot: Boolean(e.spot), perpListedDaysAgo: listedBefore ? Math.round((e.publishedAt - e.perpOnboard) / 86_400_000) : null },
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig({ ...process.env, MODELS: arg("models", "jev,mock,random") });
  setLogLevel(cfg.logLevel);
  const anonymize = arg("anonymize", "true") !== "false";
  const concurrency = Number(arg("concurrency", "6"));
  const limit = Number(arg("limit", "0"));
  const skipExisting = arg("skip-existing", "false") === "true";
  const events = (JSON.parse(readFileSync(arg("events", "data/announcements/events.json"), "utf8")) as AnnEvent[]).filter((e) => e.reaction && e.reaction.ret.h1 !== null);
  const todo = limit ? events.slice(-limit) : events;
  const ledger = new AnnLedger(arg("db", "data/announcements.sqlite"));
  const runId = randomUUID();
  log.info("start", { runId, events: todo.length, models: cfg.models, anonymize, version: ANN_QUESTION_VERSION });

  const upsertEvent = ledger.db.prepare(
    `INSERT OR IGNORE INTO ann_events (code, base, published_at, kind, grp, catalog, title, market, ret_h1, ret_h24, ret_m5, ret_m30, ret_h1_slow, max_up_1h, max_down_1h, pre_h1, pre_h24, volume_ratio_1h, label_h1, label_h24, state_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getId = ledger.db.prepare("SELECT id FROM ann_events WHERE code = ? AND base = ?");
  const hasDecision = ledger.db.prepare("SELECT 1 FROM ann_decisions WHERE event_id = ? AND model = ? AND question_version = ? AND anonymized = ? AND error IS NULL");
  const insertDecision = ledger.db.prepare(
    `INSERT OR REPLACE INTO ann_decisions (event_id, model, question_version, anonymized, ts, latency_ms, event_choice, p_h1_up, p_h1_down, p_h1_flat, p_h24_up, p_h24_down, p_h24_flat, novelty, answers_json, input_tokens, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const client = cfg.models.includes("jev") ? new TypeSafeClient({ apiKey: cfg.typesafe.apiKey!, defaultModel: cfg.typesafe.model, timeout: 15_000, retry: { maxRetries: 2 } }) : null;
  const questions = annQuestions(2 * cfg.costs.takerFeeBps + 2 * cfg.costs.slippageBpsPerSide);
  const rnd = mulberry32(7);

  const askJev = async (state: AnnState): Promise<Answers> => {
    const t0 = performance.now();
    const res = await client!.systemOne({ state: state as unknown as Record<string, never>, questions });
    const a = res.answers as unknown as { event: ChoiceResponse; h1: ChoiceResponse; h24: ChoiceResponse; novelty: NoulResponse };
    return { event: a.event.choice, h1: a.h1.probabilities as Record<Impact, number>, h24: a.h24.probabilities as Record<Impact, number>, novelty: a.novelty.noul, latencyMs: Math.round(performance.now() - t0), inputTokens: res.usage.input_tokens };
  };

  let done = 0;
  let errors = 0;
  const queue = [...todo];
  const worker = async () => {
    for (;;) {
      const e = queue.shift();
      if (!e) return;
      const r = e.reaction!;
      const state = buildState(e, anonymize);
      upsertEvent.run(e.code, e.base, e.publishedAt, e.kind, e.group ?? "meme", e.catalog, e.title, r.market, r.ret.h1, r.ret.h24, r.ret.m5, r.ret.m30, r.retSlow.h1, r.maxUp1h, r.maxDown1h, r.pre.h1, r.pre.h24, r.volumeRatio1h, impactLabel(r.ret.h1, H1_PCT), impactLabel(r.ret.h24, H24_PCT), JSON.stringify(state));
      const eventId = (getId.get(e.code, e.base) as { id: number }).id;
      for (const model of cfg.models) {
        if (skipExisting && hasDecision.get(eventId, model, ANN_QUESTION_VERSION, anonymize ? 1 : 0)) continue;
        let ans: Answers | null = null;
        let error: string | null = null;
        try {
          ans = model === "jev" ? await askJev(state) : model === "mock" ? mockAnswer(e) : randomAnswer(rnd);
        } catch (err) {
          errors++;
          error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          log.warn("model failed", { model, code: e.code, error });
        }
        insertDecision.run(eventId, model, ANN_QUESTION_VERSION, anonymize ? 1 : 0, Date.now(), ans?.latencyMs ?? null, ans?.event ?? null, ans?.h1.up ?? null, ans?.h1.down ?? null, ans?.h1.flat ?? null, ans?.h24.up ?? null, ans?.h24.down ?? null, ans?.h24.flat ?? null, ans?.novelty ?? null, ans ? JSON.stringify(ans) : null, ans?.inputTokens ?? null, error);
      }
      done++;
      if (done % 50 === 0) log.info("progress", { done, of: todo.length, errors });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  log.info("done", { done, errors });
  ledger.close();
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
