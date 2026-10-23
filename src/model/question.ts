import type { Config } from "../config.js";
import { roundTripCostBps } from "../state/builder.js";
import type { QuestionSpec } from "./types.js";

export const QUESTION_VERSION = "tb-v1";

/**
 * The triple-barrier question. It states the goal, the horizon and the cost context explicitly;
 * bare labels like "long or short?" are deliberately avoided.
 */
export function buildQuestion(cfg: Config): QuestionSpec {
  const x = cfg.question.barrierPct;
  const mins = cfg.question.horizonMs / 60_000;
  const cost = roundTripCostBps(cfg);
  const spec: QuestionSpec = {
    version: QUESTION_VERSION,
    barrier: {
      type: "choice",
      instructions:
        `The state is a live snapshot of one Binance USDT-margined perpetual futures contract on a meme coin, ` +
        `built from the order book, recent trades, 1-minute candles, funding and open interest. ` +
        `Goal: decide whether a short scalp has an edge. Starting from the current mid price (book.mid), ` +
        `which barrier will the mid price reach FIRST within the next ${mins} minutes: ` +
        `the up barrier at +${x}% or the down barrier at -${x}%? ` +
        `A round trip costs about ${cost} bps in fees and slippage, so only a clear lean is worth trading; ` +
        `when the two outcomes look balanced, spread probability accordingly. ` +
        `Consider that small, illiquid coins tend to mean-revert over minutes while large, liquid ones tend to continue, ` +
        `and that sharp moves on thin books are often manufactured.`,
      criteria: {
        up_first: `Mid reaches +${x}% above the current mid before it reaches -${x}% below, within ${mins} minutes.`,
        down_first: `Mid reaches -${x}% below the current mid before it reaches +${x}% above, within ${mins} minutes.`,
        neither: `Mid reaches neither barrier within ${mins} minutes.`,
      },
    },
  };
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
