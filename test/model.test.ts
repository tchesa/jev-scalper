import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { MockModel } from "../src/model/mock.js";
import { buildQuestion } from "../src/model/question.js";
import { RandomModel } from "../src/model/random.js";
import type { SymbolState } from "../src/types.js";

const cfg = loadConfig({});
const question = buildQuestion(cfg);

export function sampleState(over: Partial<SymbolState> = {}): SymbolState {
  return {
    symbol: "TESTUSDT",
    ts: "2026-10-23T00:00:00.000Z",
    tier: "small",
    daysSinceListing: 120,
    book: { mid: 1, spreadBps: 5, imbalanceTop5: 0, depthUsd: { bps10: [1e4, 1e4], bps25: [3e4, 3e4], bps50: [6e4, 6e4] }, bids: [[0.9999, 1000]], asks: [[1.0001, 1000]] },
    returnsPct: { s30: 0, m1: 0, m5: 0, m15: 0, h1: 0 },
    trades: { count1m: 50, buyUsd1m: 5e4, sellUsd1m: 5e4, cvdUsd1m: 0, cvdUsd5m: 0, vwap1m: 1, vwap5m: 1, vwapDistBps5m: 0, largestUsd1m: 1e3, recent: [] },
    indicators1m: { sma20: 1, sma50: 1, ema20: 1, rsi14: 50, realizedVolPct1m: 0.1, realizedVolPct5m: 0.3, rangePos1h: 0.5, rangePos24h: 0.5, range5mPct: 0.4 },
    perp: { mark: 1, premiumBps: 0, fundingRatePct: 0.01, fundingIntervalHours: 8, minsToFunding: 100, fundingChange1hPct: 0, oiUsd: 1e7, oiChangePct5m: 0, oiChangePct30m: 0 },
    daily: { quoteVolumeUsd: 2e7, changePct: 0, distFromHighPct: 5, distFromLowPct: 5 },
    barrier: { upPct: 0.5, downPct: 0.5, horizonMin: 5, roundTripCostBps: 30 },
    ...over,
  };
}

describe("question", () => {
  it("states goal, horizon and cost, with descriptive criteria", () => {
    expect(question.barrier.instructions).toMatch(/5 minutes/);
    expect(question.barrier.instructions).toMatch(/\+0\.5%/);
    expect(question.barrier.instructions).toMatch(/30 bps/);
    expect(Object.keys(question.barrier.criteria)).toEqual(["up_first", "down_first", "neither"]);
    expect(question.regime).toBeDefined();
  });
});

describe("MockModel", () => {
  const m = new MockModel();
  const signal = new AbortController().signal;

  it("is deterministic and returns a distribution", async () => {
    const a = await m.evaluate(sampleState(), question, signal);
    const b = await m.evaluate(sampleState(), question, signal);
    expect(a.barrier).toEqual(b.barrier);
    const sum = Object.values(a.barrier.probabilities).reduce((x, y) => x + y, 0);
    expect(sum).toBeCloseTo(1);
    expect(a.regime?.choice).toBeDefined();
  });

  it("fades a spike on a small coin and follows it on a large one", async () => {
    const spike = { returnsPct: { s30: 0.2, m1: 0.4, m5: 1.2, m15: 1.5, h1: 2 } };
    const small = await m.evaluate(sampleState({ tier: "small", ...spike }), question, signal);
    const large = await m.evaluate(sampleState({ tier: "large", ...spike }), question, signal);
    expect(small.barrier.probabilities.down_first).toBeGreaterThan(small.barrier.probabilities.up_first);
    expect(large.barrier.probabilities.up_first).toBeGreaterThan(large.barrier.probabilities.down_first);
  });

  it("raises P(neither) when realized vol is far below the barrier", async () => {
    const quiet = await m.evaluate(sampleState({ indicators1m: { ...sampleState().indicators1m, realizedVolPct5m: 0.05 } }), question, signal);
    const wild = await m.evaluate(sampleState({ indicators1m: { ...sampleState().indicators1m, realizedVolPct5m: 2 } }), question, signal);
    expect(quiet.barrier.probabilities.neither).toBeGreaterThan(wild.barrier.probabilities.neither);
  });
});

describe("RandomModel", () => {
  it("is reproducible per seed and sums to one", async () => {
    const signal = new AbortController().signal;
    const a = await new RandomModel(7).evaluate(sampleState(), question, signal);
    const b = await new RandomModel(7).evaluate(sampleState(), question, signal);
    expect(a.barrier).toEqual(b.barrier);
    expect(Object.values(a.barrier.probabilities).reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });
});
