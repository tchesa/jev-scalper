import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { SymbolFeed } from "../src/market/symbolFeed.js";
import { prefilter } from "../src/prefilter.js";
import { buildState } from "../src/state/builder.js";

const cfg = loadConfig({});

/** A synthetic but internally consistent feed: 80 closed 1m bars around 1.0, a tight book, steady prints. */
function syntheticFeed(now: number): SymbolFeed {
  const feed = new SymbolFeed({ symbol: "TESTUSDT", baseAsset: "TEST", onboardDate: now - 100 * 86_400_000, tickSize: 0.0001, stepSize: 1, fundingIntervalHours: 4, tags: ["Meme"] });
  const bids: Array<[string, string]> = [];
  const asks: Array<[string, string]> = [];
  for (let i = 0; i < 50; i++) {
    bids.push([(0.9999 - i * 0.0001).toFixed(4), "100000"]);
    asks.push([(1.0001 + i * 0.0001).toFixed(4), "100000"]);
  }
  feed.book.applySnapshot({ lastUpdateId: 1, eventTime: now, bids, asks });
  feed.book.lastEventTime = now;
  for (let i = 80; i >= 1; i--) {
    const t = now - i * 60_000 - (now % 60_000);
    const px = 1 + Math.sin(i / 5) * 0.002;
    feed.klines.push({ openTime: t, closeTime: t + 59_999, open: px, high: px + 0.001, low: px - 0.001, close: px, volume: 1e5, quoteVolume: 1e5, trades: 100, takerBuyQuote: 5e4, closed: true });
  }
  for (let i = 300; i >= 0; i--) {
    feed.trades.push({ ts: now - i * 1000, price: 1 + (i % 2 ? 0.0001 : -0.0001), qty: 500, buyerTaker: i % 3 !== 0 });
    feed.mids.push({ ts: now - i * 1000, mid: 1 - i * 0.00001 });
  }
  feed.onMark({ e: "markPriceUpdate", E: now, s: "TESTUSDT", p: "1.0002", i: "1.0000", P: "1", r: "0.0001", T: now + 3_600_000 });
  feed.onOpenInterest(now - 6 * 60_000, 1_000_000);
  feed.onOpenInterest(now, 1_010_000);
  feed.ticker = { symbol: "TESTUSDT", lastPrice: 1, priceChangePct: 3.2, high: 1.05, low: 0.95, quoteVolume: 80e6, volume: 80e6, trades: 1e5 };
  return feed;
}

describe("buildState", () => {
  const now = 1_792_790_000_000;
  const feed = syntheticFeed(now);

  it("passes the prefilter on a healthy feed", () => {
    const r = prefilter(feed, cfg, now);
    expect(r.reasons).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it("produces a complete, rounded state", () => {
    const s = buildState(feed, cfg, now)!;
    expect(s).not.toBeNull();
    expect(s.tier).toBe("mid");
    expect(s.book.mid).toBe(1);
    expect(s.book.spreadBps).toBeCloseTo(2, 1);
    expect(s.book.bids).toHaveLength(5);
    expect(s.book.depthUsd!.bps25[0]).toBeGreaterThan(0);
    expect(s.book.depthPct1Usd[0]).toBeGreaterThanOrEqual(s.book.depthUsd!.bps50[0]);
    expect(s.bars1m).toBeUndefined();
    expect(s.returnsPct.s30).toBeCloseTo(0.03, 2);
    expect(s.returnsPct.m5).toBeCloseTo(0.3, 1);
    expect(s.trades.count1m).toBe(61);
    expect(s.trades.recent).toHaveLength(15);
    expect(s.indicators1m.sma20).not.toBeNull();
    expect(s.indicators1m.rsi14).toBeGreaterThan(0);
    expect(s.perp.fundingIntervalHours).toBe(4);
    expect(s.perp.premiumBps).toBeCloseTo(2, 0);
    expect(s.perp.oiChangePct5m).toBeCloseTo(1, 1);
    expect(s.daily.distFromHighPct).toBeCloseTo(4.76, 1);
    expect(s.barrier).toEqual({ upPct: 0.5, downPct: 0.5, horizonMin: 5, roundTripCostBps: 30 });
    // Keep the payload small: Jev is billed per input token.
    expect(JSON.stringify(s).length).toBeLessThan(3000);
  });

  it("adds raw 1m bars and a vol-scaled barrier when configured", () => {
    const c2 = loadConfig({ STATE_BARS_1M: "10", BARRIER_MODE: "vol", BARRIER_VOL_MULT: "2", BARRIER_FLOOR_PCT: "0.3", BARRIER_CAP_PCT: "3" });
    const s = buildState(feed, c2, now)!;
    expect(s.bars1m).toHaveLength(10);
    expect(s.bars1m![9]![3]).toBeCloseTo(feed.klines[feed.klines.length - 1]!.close, 4);
    expect(s.barrier.upPct).toBeGreaterThanOrEqual(0.3);
    expect(s.barrier.upPct).toBeLessThanOrEqual(3);
    expect(s.barrier.upPct).toBe(s.barrier.downPct);
  });

  it("returns null when the feed is not ready", () => {
    const empty = new SymbolFeed({ symbol: "X", baseAsset: "X", onboardDate: 0, tickSize: 0, stepSize: 0, fundingIntervalHours: 8, tags: [] });
    expect(buildState(empty, cfg, now)).toBeNull();
    expect(prefilter(empty, cfg, now).reasons).toEqual(["not_ready"]);
  });
});
