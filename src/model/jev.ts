import { TypeSafeClient, type ChoiceQuestion, type ChoiceResponse } from "@typesafe-ai/sdk";
import type { SymbolState } from "../types.js";
import { BARRIER_OUTCOMES, type BarrierOutcome, type ChoiceAnswer, type Model, type ModelOutput, type QuestionSpec, type Regime } from "./types.js";

/** Labels the question did not offer get probability 0 (e.g. `neither` on the two-way direction probe). */
function toAnswer<L extends string>(r: ChoiceResponse, labels?: readonly L[]): ChoiceAnswer<L> {
  const probabilities = { ...(r.probabilities as Record<L, number>) };
  for (const l of labels ?? []) if (probabilities[l] === undefined) probabilities[l] = 0;
  return { choice: r.choice as L, confidence: r.confidence, probabilities };
}

/** Question keys are opaque to the model; "tb-v1" becomes "barrier_tb_v1". */
const keyFor = (version: string) => `barrier_${version.replace(/[^a-zA-Z0-9]/g, "_")}`;

/** Jev via the TypeSafe SDK. State goes in as a JSON object; every variant plus regime in one request. */
export class JevModel implements Model {
  readonly name = "jev";
  private readonly client: TypeSafeClient;

  /** Live runs use no retries (a late answer is a stale answer). Replay can afford them. */
  constructor(apiKey: string, private readonly model: string, timeoutMs: number, maxRetries = 0) {
    this.client = new TypeSafeClient({
      apiKey,
      defaultModel: model,
      timeout: timeoutMs,
      retry: { maxRetries },
      logLevel: "warn",
    });
  }

  async evaluate(state: SymbolState, question: QuestionSpec, signal: AbortSignal): Promise<ModelOutput> {
    const questions: Record<string, ChoiceQuestion> = {};
    for (const v of question.variants) questions[keyFor(v.version)] = v.question as ChoiceQuestion;
    if (question.regime) questions["regime"] = question.regime as ChoiceQuestion;

    const t0 = performance.now();
    const res = await this.client.systemOne({ state: state as unknown as Record<string, never>, questions, model: this.model }, { signal });
    const latencyMs = Math.round(performance.now() - t0);
    const answers = res.answers as Record<string, ChoiceResponse | undefined>;

    const out: ModelOutput = {
      modelVersion: res.model,
      barriers: question.variants.map((v) => {
        const a = answers[keyFor(v.version)];
        if (!a) throw new Error(`Jev response missing answer for ${v.version}`);
        return { version: v.version, answer: toAnswer<BarrierOutcome>(a, BARRIER_OUTCOMES) };
      }),
      latencyMs,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
    const regime = answers["regime"];
    if (regime) out.regime = toAnswer<Regime>(regime);
    return out;
  }
}
