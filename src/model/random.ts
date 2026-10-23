import type { SymbolState } from "../types.js";
import { BARRIER_OUTCOMES, REGIMES, type BarrierOutcome, type ChoiceAnswer, type Model, type ModelOutput, type QuestionSpec, type Regime } from "./types.js";

/** Mulberry32: small seeded PRNG so random baselines are reproducible per run. */
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

function randomChoice<L extends string>(labels: readonly L[], rnd: () => number): ChoiceAnswer<L> {
  const raw = labels.map(() => -Math.log(rnd() || 1e-9)); // exponential draws -> uniform on the simplex
  const s = raw.reduce((a, b) => a + b, 0);
  const probabilities = Object.fromEntries(labels.map((l, i) => [l, raw[i]! / s])) as Record<L, number>;
  const sorted = [...labels].sort((a, b) => probabilities[b] - probabilities[a]);
  return {
    choice: sorted[0]!,
    confidence: probabilities[sorted[0]!] - (sorted[1] ? probabilities[sorted[1]] : 0),
    probabilities,
  };
}

/** Random baseline: uniform draws on the probability simplex, no look at the state. */
export class RandomModel implements Model {
  readonly name = "random";
  private readonly rnd: () => number;

  constructor(seed = 20261023) {
    this.rnd = mulberry32(seed);
  }

  async evaluate(_state: SymbolState, question: QuestionSpec, _signal?: AbortSignal): Promise<ModelOutput> {
    const out: ModelOutput = {
      modelVersion: "random-v1",
      barrier: randomChoice<BarrierOutcome>(BARRIER_OUTCOMES, this.rnd),
      latencyMs: 0,
    };
    if (question.regime) out.regime = randomChoice<Regime>(REGIMES, this.rnd);
    return out;
  }
}
