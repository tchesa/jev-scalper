import { describe, expect, it } from "vitest";
import { ema, rangePosition, realizedVolPct, rsi, sig, sma } from "../src/state/features.js";

describe("features", () => {
  it("sma / ema", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(sma([1, 2], 3)).toBeNull();
    // EMA(3) seeded with SMA of [1,2,3]=2, then k=0.5: 4 -> 3, 5 -> 4
    expect(ema([1, 2, 3, 4, 5], 3)).toBeCloseTo(4);
  });

  it("rsi is 100 on monotone gains and ~50 on alternating moves", () => {
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14)).toBe(100);
    const alt = Array.from({ length: 40 }, (_, i) => 100 + (i % 2));
    expect(rsi(alt, 14)!).toBeGreaterThan(45);
    expect(rsi(alt, 14)!).toBeLessThan(55);
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });

  it("realized vol is zero on a flat series", () => {
    expect(realizedVolPct(Array(30).fill(5), 20)).toBe(0);
    expect(realizedVolPct([1, 2], 20)).toBeNull();
  });

  it("range position clamps to [0,1]", () => {
    expect(rangePosition(5, 0, 10)).toBe(0.5);
    expect(rangePosition(12, 0, 10)).toBe(1);
    expect(rangePosition(1, 1, 1)).toBeNull();
  });

  it("sig keeps 6 significant figures across magnitudes", () => {
    expect(sig(0.0000012345678)).toBe(0.00000123457);
    expect(sig(12345.6789)).toBe(12345.7);
  });
});
