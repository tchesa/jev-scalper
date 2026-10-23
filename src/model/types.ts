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

/** Everything sent alongside the state. Versioned so answers from different wordings never mix. */
export interface QuestionSpec {
  version: string;
  barrier: ChoiceSpec<BarrierOutcome>;
  regime?: ChoiceSpec<Regime>;
}

export interface ChoiceAnswer<L extends string> {
  choice: L;
  confidence: number;
  probabilities: Record<L, number>;
}

export interface ModelOutput {
  modelVersion: string;
  barrier: ChoiceAnswer<BarrierOutcome>;
  regime?: ChoiceAnswer<Regime>;
  latencyMs: number;
  usage?: { inputTokens: number | null; outputTokens: number | null };
}

export interface Model {
  readonly name: string;
  evaluate(state: SymbolState, question: QuestionSpec, signal: AbortSignal): Promise<ModelOutput>;
}
