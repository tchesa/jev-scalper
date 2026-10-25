import type { Kline, Level, MarkUpdate, SymbolMeta, Ticker24h, Trade } from "../types.js";
import type { Ring } from "./ring.js";

/** What the state builder, prefilter and labeler read. Live and replay feeds both provide it. */
export interface BookView {
  readonly synced: boolean;
  /** True when full L2 levels are known (live). False for the replay proxy built from prints. */
  readonly hasDepth: boolean;
  mid(): number | null;
  spreadBps(): number | null;
  getBids(): Level[];
  getAsks(): Level[];
  depthUsdWithin(bps: number): [number, number];
}

export interface FeedView {
  readonly meta: SymbolMeta;
  readonly symbol: string;
  readonly book: BookView;
  readonly trades: Ring<Trade>;
  readonly mids: Ring<{ ts: number; mid: number }>;
  readonly fundingSamples: Ring<{ ts: number; rate: number }>;
  readonly oiSamples: Ring<{ ts: number; oi: number }>;
  readonly klines: Kline[];
  readonly ticker: Ticker24h | null;
  readonly lastMark: MarkUpdate | null;
  isReady(): boolean;
  isFresh(now: number): boolean;
}
