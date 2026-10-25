/**
 * Historical replay: drive the live state builder, models, labeler and ledger from Binance Vision dumps.
 *
 *   BARRIER_MODE=vol STATE_BARS_1M=20 pnpm replay -- --symbol TRUMPUSDT --from 2025-01-19 --to 2025-01-20
 *
 * Options: --db <path> (default data/replay-<symbol>-<from>.sqlite), --interval <sec> (30),
 *          --concurrency <n> (8 model calls in flight), --anonymize <true|false> (true),
 *          --cache <dir> (data/binance-vision), --models <jev,mock,random> (overrides MODELS).
 * Anonymized states carry symbol "PERP" and no timestamp, so a model cannot recall the episode.
 */
import { randomUUID } from "node:crypto";
import { getExchangeInfo } from "../binance/rest.js";
import { loadConfig } from "../config.js";
import { Labeler } from "../labeler/labeler.js";
import { Ledger } from "../ledger/db.js";
import { logger, setLogLevel } from "../log.js";
import { createModels } from "../model/index.js";
import { buildQuestion } from "../model/question.js";
import type { Model, ModelOutput } from "../model/types.js";
import { prefilter } from "../prefilter.js";
import { buildState } from "../state/builder.js";
import type { Kline, SymbolMeta, SymbolState } from "../types.js";
import { ReplayFeed, type FundingPoint } from "./replayFeed.js";
import { dayBefore, daysBetween, fetchDataset, parseAggTradeRow, parseDepthRow, parseKlineRow, parseMetricsRow, readAll, streamCsv, unlinkIfPartial } from "./vision.js";

const log = logger("replay");

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function fundingHistory(symbol: string, startMs: number, endMs: number): Promise<FundingPoint[]> {
  const out: FundingPoint[] = [];
  let cursor = startMs - 2 * 86_400_000;
  while (cursor < endMs + 86_400_000) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endMs + 86_400_000}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fundingRate -> ${res.status}`);
    const rows = (await res.json()) as Array<{ fundingTime: number; fundingRate: string }>;
    if (!rows.length) break;
    for (const r of rows) out.push({ fundingTime: r.fundingTime, rate: Number(r.fundingRate) });
    cursor = rows[rows.length - 1]!.fundingTime + 1;
    if (rows.length < 1000) break;
  }
  return out.sort((a, b) => a.fundingTime - b.fundingTime);
}

/** Simple bounded concurrency for model calls so replay is not serialized on Jev latency. */
class Pool {
  private active = 0;
  private queue: Array<() => void> = [];
  private all: Promise<void>[] = [];
  constructor(private readonly limit: number) {}
  run(task: () => Promise<void>): void {
    const p = new Promise<void>((resolve) => {
      const start = () => {
        this.active++;
        task()
          .catch((err) => log.error("task failed", err))
          .finally(() => {
            this.active--;
            resolve();
            this.queue.shift()?.();
          });
      };
      if (this.active < this.limit) start();
      else this.queue.push(start);
    });
    this.all.push(p);
  }
  async drain(): Promise<void> {
    await Promise.all(this.all);
  }
}

async function main(): Promise<void> {
  const symbol = arg("symbol")?.toUpperCase();
  const from = arg("from");
  const to = arg("to", from);
  if (!symbol || !from || !to) throw new Error("usage: --symbol SYM --from YYYY-MM-DD [--to YYYY-MM-DD]");
  const modelsArg = arg("models");
  const cfg = loadConfig(modelsArg ? { ...process.env, MODELS: modelsArg } : process.env);
  setLogLevel(cfg.logLevel);
  cfg.prefilter.minDepth25BpsUsd = 0; // no L2 in replay
  const intervalMs = Number(arg("interval", "30")) * 1000;
  const concurrency = Number(arg("concurrency", "8"));
  const anonymize = arg("anonymize", "true") !== "false";
  const cacheDir = arg("cache", "data/binance-vision")!;
  const dbPath = arg("db", `data/replay-${symbol}-${from}.sqlite`)!;
  unlinkIfPartial(cacheDir);

  const days = daysBetween(from, to);
  const warmDay = dayBefore(from);
  const startMs = Date.parse(`${from}T00:00:00Z`);
  const endMs = Date.parse(`${to}T00:00:00Z`) + 86_400_000;

  // Metadata: current exchangeInfo (onboardDate, tickSize); fall back to defaults for delisted contracts.
  const metas = await getExchangeInfo().catch(() => [] as SymbolMeta[]);
  const meta: SymbolMeta = metas.find((m) => m.symbol === symbol) ?? { symbol, baseAsset: symbol.replace(/USDT$/, ""), onboardDate: startMs, tickSize: 0, stepSize: 0, fundingIntervalHours: 8, tags: [] };

  log.info("loading", { symbol, days: [warmDay, ...days], cache: cacheDir });
  const loadKlines = async (ds: "klines" | "markPriceKlines" | "premiumIndexKlines"): Promise<Kline[]> => {
    const rows: Kline[] = [];
    for (const d of [warmDay, ...days]) rows.push(...(await readAll(await fetchDataset(ds, symbol, d, cacheDir))).map(parseKlineRow));
    return rows.sort((a, b) => a.openTime - b.openTime);
  };
  const [klines, marks, premiums] = await Promise.all([loadKlines("klines"), loadKlines("markPriceKlines"), loadKlines("premiumIndexKlines")]);
  const metrics = [];
  const depth = [];
  for (const d of days) {
    metrics.push(...(await readAll(await fetchDataset("metrics", symbol, d, cacheDir))).map(parseMetricsRow));
    depth.push(...(await readAll(await fetchDataset("bookDepth", symbol, d, cacheDir))).map(parseDepthRow));
  }
  const funding = await fundingHistory(symbol, startMs, endMs).catch((err) => {
    log.warn("funding history unavailable", err);
    return [] as FundingPoint[];
  });
  if (klines.length < 60) throw new Error("not enough klines for this symbol/date range");
  const inferredInterval = funding.length >= 2 ? Math.round((funding[1]!.fundingTime - funding[0]!.fundingTime) / 3_600_000) : 8;
  meta.fundingIntervalHours = inferredInterval || 8;
  log.info("loaded", { klines: klines.length, marks: marks.length, premiums: premiums.length, metrics: metrics.length, depthRows: depth.length, funding: funding.length, fundingIntervalHours: meta.fundingIntervalHours });

  const feed = new ReplayFeed(meta, klines, marks, premiums, metrics, depth, funding);
  const ledger = new Ledger(dbPath);
  const labeler = new Labeler((row) => ledger.insertLabel(row));
  const models: Model[] = createModels(cfg, { jevRetries: 2 });
  const runId = randomUUID();
  ledger.insertRun(runId, Date.now(), { replay: { symbol, from, to, intervalMs, anonymize }, ...cfg, typesafe: { ...cfg.typesafe, apiKey: undefined }, binance: undefined }, buildQuestion(cfg));
  const pool = new Pool(concurrency);

  let nextTick = startMs;
  let nextRound = startMs;
  let rounds = 0;
  let states = 0;
  let rejects: Record<string, number> = {};
  let lastProgress = startMs;

  const ask = (model: Model, stateId: number, state: SymbolState, question: ReturnType<typeof buildQuestion>, ts: number) =>
    pool.run(async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), cfg.loop.modelTimeoutMs * 3);
      let output: ModelOutput | null = null;
      let error: string | null = null;
      try {
        output = await model.evaluate(state, question, ac.signal);
      } catch (err) {
        error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      } finally {
        clearTimeout(timer);
      }
      if (output) for (const { version, answer } of output.barriers) ledger.insertDecision({ stateId, model: model.name, questionVersion: version, ts, output, barrier: answer, error: null });
      else for (const v of question.variants) ledger.insertDecision({ stateId, model: model.name, questionVersion: v.version, ts, output: null, barrier: null, error });
    });

  const round = (now: number) => {
    const roundId = `${now}-${rounds++}`;
    const r = prefilter(feed, cfg, now);
    if (!r.pass) {
      for (const reason of r.reasons) rejects[reason.split("_")[0]!] = (rejects[reason.split("_")[0]!] ?? 0) + 1;
      ledger.insertRound({ id: roundId, runId, ts: now, considered: 1, passed: 0, queried: 0, rejects: Object.fromEntries(r.reasons.map((x) => [x, 1])) });
      return;
    }
    const state = buildState(feed, cfg, now);
    if (!state) return;
    if (anonymize) {
      state.symbol = "PERP";
      state.ts = null;
    }
    const stateId = ledger.insertState({ runId, roundId, ts: now, state, horizonMs: cfg.question.horizonMs, prefilterScore: r.score });
    states++;
    labeler.track(stateId, symbol, now, feed.book.mid()!, state.barrier.upPct, cfg.question.horizonMs);
    const question = buildQuestion(cfg, state.barrier.upPct);
    for (const m of models) ask(m, stateId, state, question, now);
    ledger.insertRound({ id: roundId, runId, ts: now, considered: 1, passed: 1, queried: 1, rejects: {} });
  };

  const tick = (t: number) => {
    feed.setClock(t);
    feed.sampleMid(t);
    labeler.onTick(symbol, t, feed.book.mid());
    if (t >= nextRound) {
      round(t);
      nextRound = t + intervalMs;
    }
    if (t - lastProgress >= 3_600_000) {
      lastProgress = t;
      log.info("progress", { at: new Date(t).toISOString(), rounds, states, pendingLabels: labeler.pendingCount, rejects });
      rejects = {};
    }
  };

  // Warm-up: release the previous day's bars so indicators and the 24h window exist at the first round.
  feed.setClock(startMs - 1);

  let lastTradeTs = startMs;
  let tradeRows = 0;
  for (const day of days) {
    const zip = await fetchDataset("aggTrades", symbol, day, cacheDir);
    if (!zip) {
      log.warn("no aggTrades for day, skipping", { day });
      continue;
    }
    log.info("replaying", { day });
    for await (const row of streamCsv(zip)) {
      const t = parseAggTradeRow(row);
      if (!Number.isFinite(t.ts) || t.ts < lastTradeTs - 5_000) continue;
      while (nextTick <= t.ts) {
        tick(nextTick);
        nextTick += 1000;
      }
      feed.onTrade(t.ts, t.price, t.qty, t.buyerTaker);
      labeler.onTrade(symbol, t.ts, t.price);
      if (t.ts > lastTradeTs) lastTradeTs = t.ts;
      tradeRows++;
    }
  }
  // Prices after the data end are unknown: anything still pending is lost, not "neither".
  labeler.flushAsLost(lastTradeTs);
  log.info("data exhausted, waiting for model calls", { tradeRows, rounds, states });
  await pool.drain();

  const summary = ledger.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM states WHERE run_id = ?) AS states,
              (SELECT COUNT(*) FROM decisions d JOIN states s ON s.id = d.state_id WHERE s.run_id = ? AND d.error IS NOT NULL) AS errors,
              (SELECT COUNT(*) FROM labels l JOIN states s ON s.id = l.state_id WHERE s.run_id = ? AND l.outcome = 'up_first') AS up,
              (SELECT COUNT(*) FROM labels l JOIN states s ON s.id = l.state_id WHERE s.run_id = ? AND l.outcome = 'down_first') AS down,
              (SELECT COUNT(*) FROM labels l JOIN states s ON s.id = l.state_id WHERE s.run_id = ? AND l.outcome = 'neither') AS neither,
              (SELECT COUNT(*) FROM labels l JOIN states s ON s.id = l.state_id WHERE s.run_id = ? AND l.outcome = 'lost') AS lost`,
    )
    .get(runId, runId, runId, runId, runId, runId);
  log.info("done", { db: dbPath, ...(summary as object) });
  ledger.close();
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
