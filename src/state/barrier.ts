import type { Config } from "../config.js";
import { realizedVolPct } from "./features.js";

/**
 * Barrier distance (%) for one state. In "vol" mode the barrier is a multiple of the realized
 * move expected over the horizon (20-bar 1m vol scaled by sqrt(horizon minutes)), clamped so it
 * never sits inside trading costs or absurdly far away. Code owns reachability; the model only
 * has to judge direction and whether the move will complete.
 */
export function barrierPctFor(cfg: Config, closes: readonly number[]): number {
  if (cfg.question.barrierMode === "fixed") return cfg.question.barrierPct;
  const vol1m = realizedVolPct(closes, 20);
  if (vol1m === null) return cfg.question.barrierPct;
  const horizonMin = cfg.question.horizonMs / 60_000;
  const raw = cfg.question.barrierVolMult * vol1m * Math.sqrt(horizonMin);
  const clamped = Math.min(cfg.question.barrierCapPct, Math.max(cfg.question.barrierFloorPct, raw));
  return Math.round(clamped * 1000) / 1000;
}
