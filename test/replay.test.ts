import { describe, expect, it } from "vitest";
import { ReplayBook, ReplayFeed } from "../src/replay/replayFeed.js";
import { parseAggTradeRow, parseDepthRow, parseKlineRow, parseMetricsRow, dayBefore, daysBetween } from "../src/replay/vision.js";
import type { Kline } from "../src/types.js";

describe("ReplayBook", () => {
  it("derives bid/ask from sell- and buy-aggressor prints", () => {
    const b = new ReplayBook(0.01);
    b.onTrade(1000, 100.0, false); // seller hit the bid at 100.00
    b.onTrade(1500, 100.02, true); // buyer lifted the ask at 100.02
    expect(b.mid()).toBeCloseTo(100.01);
    expect(b.spreadBps()).toBeCloseTo(2, 0);
    expect(b.hasDepth).toBe(false);
    expect(b.getBids()).toEqual([]);
  });

  it("falls back to last print when quotes cross or one side is stale", () => {
    const b = new ReplayBook(0.01);
    b.onTrade(1000, 100.0, false);
    b.onTrade(1500, 99.5, true); // ask below bid: price fell
    expect(b.mid()).toBeCloseTo(99.5);
    expect(b.spreadBps()!).toBeGreaterThan(0);
    b.onTrade(200_000, 98, true); // bid is now > 60 s old
    expect(b.mid()).toBeCloseTo(98);
  });

  it("serves ±1% depth from the bookDepth dump only", () => {
    const b = new ReplayBook(0.01);
    b.depthPct1 = [1e6, 2e6];
    expect(b.depthUsdWithin(100)).toEqual([1e6, 2e6]);
    expect(b.depthUsdWithin(25)).toEqual([0, 0]);
  });
});

describe("ReplayFeed", () => {
  const minute = 60_000;
  const t0 = Date.parse("2025-01-19T00:00:00Z");
  const bars: Kline[] = Array.from({ length: 1500 }, (_, i) => {
    const o = t0 - 1500 * minute + i * minute;
    const px = 10 + Math.sin(i / 50);
    return { openTime: o, closeTime: o + minute - 1, open: px, high: px + 0.05, low: px - 0.05, close: px + 0.01, volume: 100, quoteVolume: 1000, trades: 10, takerBuyQuote: 500, closed: true };
  });
  const marks = bars.map((k) => ({ ...k, close: k.close * 1.0001 }));
  const prem = bars.map((k) => ({ ...k, close: 0.0001 }));
  const meta = { symbol: "TESTUSDT", baseAsset: "TEST", onboardDate: 0, tickSize: 0.001, stepSize: 1, fundingIntervalHours: 8, tags: [] };

  it("releases only bars the clock has passed and builds a rolling 24h ticker", () => {
    const feed = new ReplayFeed(meta, bars, marks, prem, [{ ts: t0 - minute, oi: 5, oiUsd: 50 }], [{ ts: t0 - minute, pct: -1, notional: 7 }, { ts: t0 - minute, pct: 1, notional: 9 }], [{ fundingTime: t0 - 3 * 3_600_000, rate: 0.0001 }, { fundingTime: t0 + 5 * 3_600_000, rate: 0.0002 }]);
    feed.setClock(t0 - 1);
    expect(feed.klines.length).toBe(1500); // all closed before t0
    expect(feed.ticker!.high).toBeGreaterThan(feed.ticker!.low);
    expect(feed.ticker!.quoteVolume).toBe(1440 * 1000); // exactly 24h of bars
    expect(feed.lastMark!.fundingRate).toBe(0.0001);
    expect(feed.lastMark!.nextFundingTime).toBe(t0 + 5 * 3_600_000);
    expect(feed.lastMark!.index).toBeCloseTo(feed.lastMark!.mark / 1.0001, 6);
    expect(feed.oiSamples.last()).toEqual({ ts: t0 - minute, oi: 5 });
    expect(feed.book.depthPct1).toEqual([7, 9]);
    expect(feed.isReady()).toBe(false); // no prints yet
    feed.onTrade(t0, 10.5, 3, true);
    expect(feed.isReady()).toBe(true);
  });
});

describe("vision parsers", () => {
  it("parse dump rows", () => {
    expect(parseAggTradeRow("82945973,0.01844,299.0,257755974,257755974,1792454403620,false".split(","))).toEqual({ ts: 1792454403620, price: 0.01844, qty: 299, buyerTaker: true });
    expect(parseAggTradeRow("1,1,1,1,1,5,true".split(",")).buyerTaker).toBe(false);
    const k = parseKlineRow("1737244800000,28.449000,28.913000,28.016000,28.456000,334346.51,1737244859999,9477461.79511000,26915,162619.90,4609406.02765000,0".split(","));
    expect(k).toMatchObject({ openTime: 1737244800000, close: 28.456, quoteVolume: 9477461.79511, trades: 26915, closed: true });
    expect(parseMetricsRow("2025-01-19 00:05:00,TRUMPUSDT,5163764.0,142186995.73,3.5,1.0,4.4,0.88".split(","))).toEqual({ ts: Date.parse("2025-01-19T00:05:00Z"), oi: 5163764, oiUsd: 142186995.73 });
    expect(parseDepthRow("2025-01-19 00:00:05,-5,134390.8,3733961.8".split(","))).toEqual({ ts: Date.parse("2025-01-19T00:00:05Z"), pct: -5, notional: 3733961.8 });
    expect(dayBefore("2025-01-01")).toBe("2024-12-31");
    expect(daysBetween("2025-01-30", "2025-02-01")).toEqual(["2025-01-30", "2025-01-31", "2025-02-01"]);
  });
});
