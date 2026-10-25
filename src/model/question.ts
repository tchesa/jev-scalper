import type { Config } from "../config.js";
import { roundTripCostBps } from "../state/builder.js";
import type { BarrierOutcome, BarrierVariant, ChoiceSpec, QuestionSpec } from "./types.js";

export const QUESTION_VERSIONS = ["tb-v1", "tb-v2", "dir-v1"] as const;
export type QuestionVersion = (typeof QUESTION_VERSIONS)[number];

function criteria(x: number, mins: number): Record<BarrierOutcome, string> {
  return {
    up_first: `Mid reaches +${x}% above the current mid before it reaches -${x}% below, within ${mins} minutes.`,
    down_first: `Mid reaches -${x}% below the current mid before it reaches +${x}% above, within ${mins} minutes.`,
    neither: `Mid reaches neither barrier within ${mins} minutes.`,
  };
}

/**
 * tb-v1: the original wording. Besides goal, horizon and cost it carries two strategy hints
 * (small coins mean-revert, sharp moves on thin books are manufactured). Kept byte-identical
 * so rows collected before tb-v2 existed stay comparable.
 */
function tbV1(x: number, mins: number, cost: number, asset: string): ChoiceSpec<BarrierOutcome> {
  return {
    type: "choice",
    instructions:
      `The state is a live snapshot of one Binance USDT-margined perpetual futures contract on a ${asset}, ` +
      `built from the order book, recent trades, 1-minute candles, funding and open interest. ` +
      `Goal: decide whether a short scalp has an edge. Starting from the current mid price (book.mid), ` +
      `which barrier will the mid price reach FIRST within the next ${mins} minutes: ` +
      `the up barrier at +${x}% or the down barrier at -${x}%? ` +
      `A round trip costs about ${cost} bps in fees and slippage, so only a clear lean is worth trading; ` +
      `when the two outcomes look balanced, spread probability accordingly. ` +
      `Consider that small, illiquid coins tend to mean-revert over minutes while large, liquid ones tend to continue, ` +
      `and that sharp moves on thin books are often manufactured.`,
    criteria: criteria(x, mins),
  };
}

/** tb-v2: goal, horizon and cost only. No strategy hints, no view on direction. */
function tbV2(x: number, mins: number, cost: number, asset: string): ChoiceSpec<BarrierOutcome> {
  return {
    type: "choice",
    instructions:
      `The state is a live snapshot of one Binance USDT-margined perpetual futures contract on a ${asset}, ` +
      `built from the order book, recent trades, 1-minute candles, funding and open interest. ` +
      `Goal: decide whether a short scalp has an edge. Starting from the current mid price (book.mid), ` +
      `which barrier will the mid price reach FIRST within the next ${mins} minutes: ` +
      `the up barrier at +${x}%, the down barrier at -${x}%, or neither? ` +
      `A round trip costs about ${cost} bps in fees and slippage. ` +
      `Report your honest probability for each outcome; a symmetric market should get symmetric probabilities.`,
    criteria: criteria(x, mins),
  };
}

/**
 * dir-v1: two-way direction probe. Reachability is assumed (scored on barrier hits only); the model is asked
 * which barrier comes first. Pre-registered pass criteria are in REPORT.md section 8.3.
 */
function dirV1(x: number, mins: number, cost: number, asset: string): ChoiceSpec<BarrierOutcome> {
  return {
    type: "choice",
    instructions:
      `The state is a live snapshot of one Binance USDT-margined perpetual futures contract on a ${asset}, ` +
      `built from the order book, recent trades, 1-minute candles, funding and open interest. ` +
      `Goal: decide the direction of a short scalp. Assume the mid price (book.mid) WILL reach one of two barriers ` +
      `within the next ${mins} minutes: the up barrier at +${x}% or the down barrier at -${x}%. ` +
      `Which one will it reach first? A round trip costs about ${cost} bps in fees and slippage. ` +
      `Report your honest probability for each direction; a symmetric market should get 50/50.`,
    criteria: {
      up_first: `Mid reaches +${x}% above the current mid before it reaches -${x}% below.`,
      down_first: `Mid reaches -${x}% below the current mid before it reaches +${x}% above.`,
    },
  };
}

const BUILDERS: Record<QuestionVersion, (x: number, mins: number, cost: number, asset: string) => ChoiceSpec<BarrierOutcome>> = {
  "tb-v1": tbV1,
  "tb-v2": tbV2,
  "dir-v1": dirV1,
};

/**
 * The triple-barrier question in every configured wording, plus the optional regime question.
 * Every wording states the goal, the horizon and the cost context; bare labels like "long or short?" are avoided.
 */
export function buildQuestion(cfg: Config, barrierPct: number = cfg.question.barrierPct): QuestionSpec {
  const x = barrierPct;
  const mins = cfg.question.horizonMs / 60_000;
  const cost = roundTripCostBps(cfg);
  // The asset label, like the barrier size, is a fact about the input substituted into the template; it does not
  // change the version. It is recorded in the run config so results can be split by it.
  const variants: BarrierVariant[] = cfg.question.versions.map((version) => ({ version, question: BUILDERS[version](x, mins, cost, cfg.question.assetLabel) }));
  const spec: QuestionSpec = { variants };
  if (cfg.question.askRegime) {
    spec.regime = {
      type: "choice",
      instructions:
        `Which regime best describes this contract right now, judging from flow, book shape, open interest, ` +
        `funding and how long it has been listed?`,
      criteria: {
        organic_momentum: "Broad participation: many trades, deepening book, open interest rising with price, funding not extreme.",
        manipulation: "Pump-and-dump or wash-trading signature: sharp move on a thin book, few large prints, lopsided book, open interest flat.",
        listing_event: "Recently listed contract with price discovery still underway.",
        exhaustion: "A move that is running out of steam: extreme RSI, divergence between price and flow, funding stretched.",
        quiet: "Low activity, tight range, no directional flow.",
      },
    };
  }
  return spec;
}
