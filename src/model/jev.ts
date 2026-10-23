import { TypeSafeClient, type ChoiceResponse } from "@typesafe-ai/sdk";
import type { SymbolState } from "../types.js";
import type { BarrierOutcome, ChoiceAnswer, Model, ModelOutput, QuestionSpec, Regime } from "./types.js";

function toAnswer<L extends string>(r: ChoiceResponse): ChoiceAnswer<L> {
  return {
    choice: r.choice as L,
    confidence: r.confidence,
    probabilities: r.probabilities as Record<L, number>,
  };
}

/** Jev via the TypeSafe SDK. State goes in as a JSON object, questions as typed choices. */
export class JevModel implements Model {
  readonly name = "jev";
  private readonly client: TypeSafeClient;

  constructor(apiKey: string, private readonly model: string, timeoutMs: number) {
    this.client = new TypeSafeClient({
      apiKey,
      defaultModel: model,
      timeout: timeoutMs,
      // No retries: a late answer is a stale answer. The loop treats failure as "no trade".
      retry: { maxRetries: 0 },
      logLevel: "warn",
    });
  }

  async evaluate(state: SymbolState, question: QuestionSpec, signal: AbortSignal): Promise<ModelOutput> {
    const questions = question.regime
      ? { barrier: question.barrier, regime: question.regime }
      : { barrier: question.barrier };
    const t0 = performance.now();
    const res = await this.client.systemOne(
      { state: state as unknown as Record<string, never>, questions, model: this.model },
      { signal },
    );
    const latencyMs = Math.round(performance.now() - t0);
    const out: ModelOutput = {
      modelVersion: res.model,
      barrier: toAnswer<BarrierOutcome>(res.answers.barrier as ChoiceResponse),
      latencyMs,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
    const regime = (res.answers as Record<string, ChoiceResponse | undefined>)["regime"];
    if (regime) out.regime = toAnswer<Regime>(regime);
    return out;
  }
}
