import { describe, expect, it } from "vitest";
import { anonymizeText } from "../src/announcements/anonymize.js";
import { bodyToText } from "../src/announcements/fetch.js";
import { eventKind, matchAssets, type TrackedAsset } from "../src/announcements/match.js";
import { measure } from "../src/announcements/reaction.js";
import { impactLabel } from "../src/announcements/question.js";
import type { Kline } from "../src/types.js";

const assets: TrackedAsset[] = [
  { base: "PEPE", perp: "1000PEPEUSDT", spot: "PEPEUSDT", perpOnboard: 1 },
  { base: "PUMP", perp: "PUMPUSDT", spot: "PUMPUSDT", perpOnboard: 1 },
  { base: "B", perp: "BUSDT", spot: null, perpOnboard: 1 },
  { base: "TRUMP", perp: "TRUMPUSDT", spot: "TRUMPUSDT", perpOnboard: 1 },
];

describe("bodyToText", () => {
  it("walks the JSON node tree and decodes entities", () => {
    const body = JSON.stringify({ node: "root", child: [{ node: "element", tag: "p", child: [{ node: "text", text: "Fellow Binancians,&nbsp;" }] }, { node: "element", tag: "p", child: [{ node: "text", text: "launch PEPEUSDT &amp; more" }] }] });
    expect(bodyToText(body)).toBe("Fellow Binancians,\nlaunch PEPEUSDT & more");
  });
  it("falls back to HTML", () => {
    expect(bodyToText("<p>Hello&nbsp;<b>world</b></p><p>two</p>")).toBe("Hello world\ntwo");
  });
});

describe("matchAssets", () => {
  it("matches whole-word symbols in title, body and pairs", () => {
    expect(matchAssets({ title: "Binance Futures Will Launch USDⓈ-M 1000PEPEUSDT Perpetual Contract" }, assets).map((a) => a.base)).toEqual(["PEPE"]);
    expect(matchAssets({ title: "Binance Will List Pepe (PEPE)" }, assets).map((a) => a.base)).toEqual(["PEPE"]);
    expect(matchAssets({ title: "PEPECOIN listing" }, assets)).toEqual([]);
    expect(matchAssets({ title: "Binance Futures Will Delist PUMPBTCUSDT Perpetual Contract" }, assets)).toEqual([]);
    expect(matchAssets({ title: "Delisting", text: "PUMPUSDT, PEPEBTC" }, assets).map((a) => a.base)).toEqual(["PEPE", "PUMP"]);
    expect(matchAssets({ title: "Leverage update", text: "Affected: 1000PEPEUSDT, TRUMPUSDT" }, assets).map((a) => a.base)).toEqual(["PEPE", "TRUMP"]);
  });
  it("guards ambiguous names against plain English", () => {
    expect(matchAssets({ title: "Pump up your rewards: trade to share 100,000 USDT" }, assets)).toEqual([]);
    expect(matchAssets({ title: "Binance Will List Pump.fun (PUMP)" }, assets).map((a) => a.base)).toEqual(["PUMP"]);
    expect(matchAssets({ title: "Plan B for Binance", text: "" }, assets)).toEqual([]);
    expect(matchAssets({ title: "Binance Futures Will Launch BUSDT Perpetual", text: "" }, assets).map((a) => a.base)).toEqual(["B"]);
    expect(matchAssets({ title: "Trump administration news" }, assets)).toEqual([]);
    expect(matchAssets({ title: "Binance Will List OFFICIAL TRUMP (TRUMP)" }, assets).map((a) => a.base)).toEqual(["TRUMP"]);
  });
});

describe("eventKind", () => {
  it("classifies common titles", () => {
    expect(eventKind("Binance Futures Will Launch USDⓈ-M PNUTUSDT Perpetual Contract")).toBe("futures_listing");
    expect(eventKind("Binance Will Delist 1000RATSUSDT Perpetual Contract")).toBe("delisting");
    expect(eventKind("Binance Futures Will Adjust Leverage and Margin Tiers of Multiple Perpetual Contracts")).toBe("leverage_margin");
    expect(eventKind("Binance Futures Will Update the Funding Rate Settlement Frequency of DOGEUSDT")).toBe("funding");
    expect(eventKind("Binance Will List Pudgy Penguins (PENGU)")).toBe("spot_listing");
    expect(eventKind("Binance Will List OFFICIAL TRUMP (TRUMP) with Seed Tag Applied")).toBe("spot_listing");
    expect(eventKind("Binance Will Extend the Monitoring Tag to MEME")).toBe("risk_tag");
    expect(eventKind("Trade PEPE to Share 500,000 USDT in Rewards")).toBe("promotion");
  });
});

describe("anonymizeText", () => {
  it("hides the token, its pairs, the project name and dates", () => {
    const t = anonymizeText("Binance Futures Will Launch USDⓈ-M 1000PEPEUSDT Perpetual Contract on 2024-05-14 10:00 (UTC). Underlying Asset: Pepe (PEPE). PEPE/USDT spot pair.", "PEPE", "1000PEPEUSDT", "PEPEUSDT");
    expect(t).not.toMatch(/PEPE/i);
    expect(t).toMatch(/TOKENUSDT Perpetual/);
    expect(t).toMatch(/DATE 10:00 \(UTC\)/);
    expect(t).toMatch(/Project \(TOKEN\)/);
    expect(t).toMatch(/TOKEN\/USDT/);
  });
  it("does not touch unrelated words for short tickers", () => {
    expect(anonymizeText("Plan B: trade BUSDT with 5x", "B", "BUSDT", null)).toBe("Plan B: trade TOKENUSDT with 5x");
  });
});

describe("measure", () => {
  const t0 = Date.parse("2025-01-01T12:00:00Z");
  const bars: Kline[] = Array.from({ length: 3000 }, (_, i) => {
    const o = t0 - 1500 * 60_000 + i * 60_000;
    const px = i < 1500 ? 100 : 100 + (i - 1500) * 0.01; // +1% per 100 minutes after publication
    return { openTime: o, closeTime: o + 59_999, open: px, high: px + 0.1, low: px - 0.1, close: px, volume: 1, quoteVolume: i >= 1500 ? 2 : 1, trades: 1, takerBuyQuote: 0.5, closed: true };
  });
  it("measures returns, excursions, pre-move and volume ratio", () => {
    const r = measure(bars, t0 + 30_000, "spot", "XUSDT")!;
    expect(r.p0).toBe(100);
    expect(r.ret.h1).toBeCloseTo(0.6, 5);
    expect(r.ret.h24).toBeCloseTo(14.4, 5);
    expect(r.retSlow.h1).toBeCloseTo((100.6 - 100.05) / 100.05 * 100, 5);
    expect(r.maxUp1h).toBeCloseTo(0.7, 5);
    expect(r.pre.h1).toBe(0);
    expect(r.volumeRatio1h).toBe(2);
    expect(impactLabel(r.ret.h1, 1)).toBe("flat");
    expect(impactLabel(r.ret.h24, 3)).toBe("up");
  });
  it("returns null outside the data", () => {
    expect(measure(bars, t0 + 5 * 86_400_000, "spot", "XUSDT")).toBeNull();
  });
});
