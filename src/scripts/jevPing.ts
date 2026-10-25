/** Sanity check for the TypeSafe key and question wiring: one Jev call on a synthetic state. */
import { loadConfig } from "../config.js";
import { JevModel } from "../model/jev.js";
import { buildQuestion } from "../model/question.js";
import type { SymbolState } from "../types.js";

const cfg = loadConfig({ ...process.env, MODELS: "jev" });
const state: SymbolState = {
  symbol: "DOGEUSDT",
  ts: new Date().toISOString(),
  tier: "large",
  daysSinceListing: 2300,
  book: { mid: 0.0794, spreadBps: 1.3, depthPct1Usd: [4800000, 4500000], imbalanceTop5: 0.12, depthUsd: { bps10: [410000, 380000], bps25: [1200000, 1100000], bps50: [2500000, 2300000] }, bids: [[0.07939, 43000], [0.07938, 41000], [0.07937, 47000], [0.07936, 55000], [0.07935, 51000]], asks: [[0.07941, 39000], [0.07942, 34000], [0.07943, 92000], [0.07944, 108000], [0.07945, 108000]] },
  returnsPct: { s30: 0.04, m1: 0.11, m5: 0.42, m15: 0.8, h1: 1.1 },
  trades: { count1m: 420, buyUsd1m: 910000, sellUsd1m: 520000, cvdUsd1m: 390000, cvdUsd5m: 1200000, vwap1m: 0.07937, vwap5m: 0.07925, vwapDistBps5m: 18.9, largestUsd1m: 61000, recent: [{ sAgo: 0.4, side: "B", px: 0.07941, usd: 2100 }, { sAgo: 1.1, side: "B", px: 0.07941, usd: 8800 }, { sAgo: 1.9, side: "S", px: 0.07939, usd: 1500 }] },
  indicators1m: { sma20: 0.07915, sma50: 0.0789, ema20: 0.0792, rsi14: 68.2, realizedVolPct1m: 0.09, realizedVolPct5m: 0.21, rangePos1h: 0.95, rangePos24h: 0.6, range5mPct: 0.5 },
  perp: { mark: 0.0794, premiumBps: 2.1, fundingRatePct: 0.01, fundingIntervalHours: 8, minsToFunding: 160, fundingChange1hPct: 0.002, oiUsd: 215000000, oiChangePct5m: 0.4, oiChangePct30m: 1.3 },
  daily: { quoteVolumeUsd: 259000000, changePct: 0.8, distFromHighPct: 1.6, distFromLowPct: 1.1 },
  barrier: { upPct: cfg.question.barrierPct, downPct: cfg.question.barrierPct, horizonMin: cfg.question.horizonMs / 60_000, roundTripCostBps: 30 },
};

const model = new JevModel(cfg.typesafe.apiKey!, cfg.typesafe.model, cfg.loop.modelTimeoutMs);
const question = buildQuestion(cfg);
const out = await model.evaluate(state, question, new AbortController().signal);
console.log(JSON.stringify(out, null, 2));
console.log(`\nvariants asked: ${question.variants.map((v) => v.version).join(", ")}; input tokens: ${out.usage?.inputTokens}`);
