import type { SymbolState } from "../types.js";

export type BarrierOutcome = "up_first" | "down_first" | "neither";
export const BARRIER_OUTCOMES: readonly BarrierOutcome[] = ["up_first", "down_first", "neither"];

export type Regime = "organic_momentum" | "manipulation" | "listing_event" | "exhaustion" | "quiet";
export const REGIMES: readonly Regime[] = ["organic_momentum", "manipulation", "listing_event", "exhaustion", "quiet"];

export interface ChoiceSpec<L extends string> {
  type: "choice";
  instructions: string;
  criteria: Record<L, string>;
}

/** One wording of the triple-barrier question. Versioned so answers from different wordings never mix. */
export interface BarrierVariant {
  version: string;
  question: ChoiceSpec<BarrierOutcome>;
}

/** Everything sent alongside the state. All variants go in one request so each state gets every answer. */
export interface QuestionSpec {
  variants: BarrierVariant[];
  regime?: ChoiceSpec<Regime>;
}

export interface ChoiceAnswer<L extends string> {
  choice: L;
  confidence: number;
  probabilities: Record<L, number>;
}

export interface BarrierAnswer {
  version: string;
  answer: ChoiceAnswer<BarrierOutcome>;
}

export interface ModelOutput {
  modelVersion: string;
  /** One answer per variant the model actually answered. Wording-blind baselines answer the first only. */
  barriers: BarrierAnswer[];
  regime?: ChoiceAnswer<Regime>;
  latencyMs: number;
  usage?: { inputTokens: number | null; outputTokens: number | null };
}

export interface Model {
  readonly name: string;
  evaluate(state: SymbolState, question: QuestionSpec, signal: AbortSignal): Promise<ModelOutput>;
}
