import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { barrierPctFor } from "../src/state/barrier.js";

const closes = (volPerBar: number, n = 40) => Array.from({ length: n }, (_, i) => 100 * Math.exp(volPerBar * (i % 2 ? 1 : -1)));

describe("barrierPctFor", () => {
  it("fixed mode returns BARRIER_PCT regardless of vol", () => {
    const cfg = loadConfig({ BARRIER_PCT: "0.7" });
    expect(barrierPctFor(cfg, closes(0.01))).toBe(0.7);
  });

  it("vol mode scales with realized vol and clamps to the floor and cap", () => {
    const cfg = loadConfig({ BARRIER_MODE: "vol", BARRIER_VOL_MULT: "1", BARRIER_FLOOR_PCT: "0.3", BARRIER_CAP_PCT: "2", HORIZON_MIN: "4" });
    expect(barrierPctFor(cfg, closes(0.00001))).toBe(0.3); // too quiet -> floor
    expect(barrierPctFor(cfg, closes(0.05))).toBe(2); // wild -> cap
    const mid = barrierPctFor(cfg, closes(0.002)); // ~0.4% per bar, times sqrt(4) = ~0.8%
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(1.2);
  });

  it("falls back to the fixed barrier when there is not enough history", () => {
    const cfg = loadConfig({ BARRIER_MODE: "vol", BARRIER_PCT: "0.5" });
    expect(barrierPctFor(cfg, [1, 2, 3])).toBe(0.5);
  });
});
