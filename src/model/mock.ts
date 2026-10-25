import type { SymbolState } from "../types.js";
import type { BarrierOutcome, ChoiceAnswer, Model, ModelOutput, QuestionSpec, Regime } from "./types.js";

function softmax3(a: number, b: number, c: number): [number, number, number] {
  const m = Math.max(a, b, c);
  const ea = Math.exp(a - m);
  const eb = Math.exp(b - m);
  const ec = Math.exp(c - m);
  const s = ea + eb + ec;
  return [ea / s, eb / s, ec / s];
}

function pick<L extends string>(probabilities: Record<L, number>): ChoiceAnswer<L> {
  const entries = Object.entries(probabilities) as Array<[L, number]>;
  entries.sort((x, y) => y[1] - x[1]);
  const top = entries[0]![1];
  const second = entries[1]?.[1] ?? 0;
  return { choice: entries[0]![0], confidence: top - second, probabilities };
}

/**
 * Rule-based baseline that encodes the research priors directly:
 * small/illiquid coins fade recent moves, large/liquid coins follow them,
 * flow (CVD, imbalance) nudges direction, and low realized vol raises P(neither).
 * Deterministic: the same state always yields the same answer.
 */
export class MockModel implements Model {
  readonly name = "mock";

  async evaluate(state: SymbolState, question: QuestionSpec, _signal?: AbortSignal): Promise<ModelOutput> {
    const t0 = performance.now();
    const b = state.barrier.upPct;
    const ret5 = state.returnsPct.m5 ?? 0;
    const ret1 = state.returnsPct.m1 ?? 0;
    const follow = state.tier === "large" || state.tier === "mid" ? 1 : -1;
    const momentum = follow * (ret5 / b) * 0.6 + follow * (ret1 / b) * 0.4;
    const flowUsd = state.trades.cvdUsd1m;
    const turnover = Math.max(state.trades.buyUsd1m + state.trades.sellUsd1m, 1);
    const flow = (flowUsd / turnover) * 0.8 + (state.book.imbalanceTop5 ?? 0) * 0.4;
    const rsiTilt = state.indicators1m.rsi14 === null ? 0 : ((50 - state.indicators1m.rsi14) / 50) * (follow === 1 ? -0.3 : 0.6);
    const dir = Math.max(-2, Math.min(2, momentum + flow + rsiTilt));

    // Reachability: expected 5-min move vs barrier. Vol in % per 5 min against barrier in %.
    const vol5 = state.indicators1m.realizedVolPct5m ?? state.indicators1m.range5mPct ?? b;
    const reach = Math.log(Math.max(vol5, 1e-4) / b); // 0 when vol equals barrier
    const neitherLogit = -reach * 1.2;

    let [pUp, pDown, pNeither] = softmax3(dir * 0.9, -dir * 0.9, neitherLogit);
    const first = question.variants[0]!;
    if (first.question.criteria.neither === undefined) {
      // Two-way variant: renormalize over the offered directions.
      const s = pUp + pDown;
      pUp /= s;
      pDown /= s;
      pNeither = 0;
    }
    const barrier = pick<BarrierOutcome>({ up_first: pUp, down_first: pDown, neither: pNeither });

    // Wording-blind: one answer, recorded under the first variant only.
    const out: ModelOutput = {
      modelVersion: "mock-v1",
      barriers: [{ version: first.version, answer: barrier }],
      latencyMs: Math.round(performance.now() - t0),
    };
    if (question.regime) {
      const spikes = Math.abs(ret5) > 2 * b;
      const thin = state.book.depthUsd ? Math.min(...state.book.depthUsd.bps25) < 50_000 : Math.min(...state.book.depthPct1Usd) < 500_000;
      const regimeScores: Record<Regime, number> = {
        organic_momentum: spikes && !thin && (state.perp.oiChangePct5m ?? 0) > 0.5 ? 2 : 0,
        manipulation: spikes && thin ? 2 : 0,
        listing_event: state.daysSinceListing < 7 ? 2.5 : -2,
        exhaustion: state.indicators1m.rsi14 !== null && (state.indicators1m.rsi14 > 75 || state.indicators1m.rsi14 < 25) ? 1.5 : 0,
        quiet: !spikes && (state.indicators1m.range5mPct ?? 0) < b * 0.5 ? 1.5 : 0,
      };
      const vals = Object.values(regimeScores);
      const m = Math.max(...vals);
      const exps = vals.map((v) => Math.exp(v - m));
      const s = exps.reduce((a, x) => a + x, 0);
      const probabilities = Object.fromEntries(Object.keys(regimeScores).map((k, i) => [k, exps[i]! / s])) as Record<Regime, number>;
      out.regime = pick<Regime>(probabilities);
    }
    return out;
  }
}
