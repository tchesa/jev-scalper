/** [price, quantity] */
export type Level = [number, number];

export interface Trade {
  ts: number; // trade time (ms)
  price: number;
  qty: number;
  /** true when the aggressor was a buyer (buyer is taker) */
  buyerTaker: boolean;
}

export interface Kline {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // base
  quoteVolume: number;
  trades: number;
  takerBuyQuote: number;
  closed: boolean;
}

export interface MarkUpdate {
  ts: number;
  mark: number;
  index: number;
  fundingRate: number; // current predicted rate for the next settlement
  nextFundingTime: number;
}

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  priceChangePct: number;
  high: number;
  low: number;
  quoteVolume: number;
  volume: number;
  trades: number;
}

export interface SymbolMeta {
  symbol: string;
  baseAsset: string;
  onboardDate: number;
  tickSize: number;
  stepSize: number;
  fundingIntervalHours: number;
  tags: string[];
}

export type LiquidityTier = "large" | "mid" | "small" | "micro";

/** The compact JSON sent to the model. All math happens before this is built. */
export interface SymbolState {
  symbol: string;
  ts: string; // ISO
  tier: LiquidityTier;
  daysSinceListing: number;
  book: {
    mid: number;
    spreadBps: number;
    imbalanceTop5: number; // (bid - ask) / (bid + ask) notional, -1..1
    depthUsd: { bps10: [number, number]; bps25: [number, number]; bps50: [number, number] }; // [bid, ask]
    bids: Level[]; // top 5
    asks: Level[];
  };
  returnsPct: { s30: number | null; m1: number | null; m5: number | null; m15: number | null; h1: number | null };
  trades: {
    count1m: number;
    buyUsd1m: number;
    sellUsd1m: number;
    cvdUsd1m: number;
    cvdUsd5m: number;
    vwap1m: number | null;
    vwap5m: number | null;
    vwapDistBps5m: number | null;
    largestUsd1m: number;
    recent: Array<{ sAgo: number; side: "B" | "S"; px: number; usd: number }>;
  };
  indicators1m: {
    sma20: number | null;
    sma50: number | null;
    ema20: number | null;
    rsi14: number | null;
    realizedVolPct1m: number | null; // stdev of 1m log returns over 20 bars, in %
    realizedVolPct5m: number | null; // over 60 bars, scaled to 5 min
    rangePos1h: number | null; // 0 = at 1h low, 1 = at 1h high
    rangePos24h: number | null;
    range5mPct: number | null; // (high - low) / mid over last 5 bars
  };
  perp: {
    mark: number;
    premiumBps: number;
    fundingRatePct: number;
    fundingIntervalHours: number;
    minsToFunding: number;
    fundingChange1hPct: number | null;
    oiUsd: number | null;
    oiChangePct5m: number | null;
    oiChangePct30m: number | null;
  };
  daily: {
    quoteVolumeUsd: number;
    changePct: number;
    distFromHighPct: number;
    distFromLowPct: number;
  };
  barrier: { upPct: number; downPct: number; horizonMin: number; roundTripCostBps: number };
}
