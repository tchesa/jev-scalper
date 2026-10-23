import type { Config } from "../config.js";
import type { SymbolFeed } from "../market/symbolFeed.js";
import type { LiquidityTier, SymbolState } from "../types.js";
import { ema, pctChange, rangePosition, realizedVolPct, round, roundOrNull, rsi, sig, sma } from "./features.js";

export function liquidityTier(quoteVolume24h: number, cfg: Config): LiquidityTier {
  if (quoteVolume24h >= cfg.tiers.largeUsd) return "large";
  if (quoteVolume24h >= cfg.tiers.midUsd) return "mid";
  if (quoteVolume24h >= cfg.tiers.smallUsd) return "small";
  return "micro";
}

export function roundTripCostBps(cfg: Config): number {
  // Pessimistic: taker both sides plus slippage both sides. Maker entries are a later refinement.
  return 2 * cfg.costs.takerFeeBps + 2 * cfg.costs.slippageBpsPerSide;
}

/**
 * Build the compact JSON state for one symbol at time `now`.
 * Returns null when the feed is not ready. Everything the model sees is computed here.
 */
export function buildState(feed: SymbolFeed, cfg: Config, now: number): SymbolState | null {
  const book = feed.book;
  const mid = book.mid();
  const spread = book.spreadBps();
  const mark = feed.lastMark;
  const ticker = feed.ticker;
  if (mid === null || spread === null || !mark || !ticker) return null;

  const bids = book.getBids().slice(0, 5);
  const asks = book.getAsks().slice(0, 5);
  const bidNotional = bids.reduce((a, [p, q]) => a + p * q, 0);
  const askNotional = asks.reduce((a, [p, q]) => a + p * q, 0);
  const imbalance = bidNotional + askNotional > 0 ? (bidNotional - askNotional) / (bidNotional + askNotional) : 0;

  // Mid history for short-window returns.
  const midAt = (msAgo: number) => feed.mids.at(now - msAgo, (m) => m.ts)?.mid ?? null;
  const closed = feed.klines.filter((k) => k.closed);
  const closes = closed.map((k) => k.close);
  const closeNBarsAgo = (n: number) => (closed.length > n ? closed[closed.length - 1 - n]!.close : null);

  // Trades.
  const t1m = feed.trades.since(now - 60_000, (t) => t.ts);
  const t5m = feed.trades.since(now - 5 * 60_000, (t) => t.ts);
  const sumUsd = (ts: typeof t1m, side?: boolean) =>
    ts.reduce((a, t) => (side === undefined || t.buyerTaker === side ? a + t.price * t.qty : a), 0);
  const vwap = (ts: typeof t1m) => {
    const usd = sumUsd(ts);
    const qty = ts.reduce((a, t) => a + t.qty, 0);
    return qty > 0 ? usd / qty : null;
  };
  const buy1m = sumUsd(t1m, true);
  const sell1m = sumUsd(t1m, false);
  const vwap5m = vwap(t5m);
  const largest1m = t1m.reduce((a, t) => Math.max(a, t.price * t.qty), 0);
  const recent = feed.trades
    .toArray()
    .slice(-15)
    .map((t) => ({
      sAgo: round((now - t.ts) / 1000, 1),
      side: (t.buyerTaker ? "B" : "S") as "B" | "S",
      px: sig(t.price),
      usd: round(t.price * t.qty, 0),
    }));

  // Ranges.
  const last5 = closed.slice(-5);
  const last60 = closed.slice(-60);
  const hi = (ks: typeof last5) => Math.max(...ks.map((k) => k.high));
  const lo = (ks: typeof last5) => Math.min(...ks.map((k) => k.low));
  const range5mPct = last5.length === 5 ? ((hi(last5) - lo(last5)) / mid) * 100 : null;
  const rangePos1h = last60.length >= 30 ? rangePosition(mid, lo(last60), hi(last60)) : null;
  const rangePos24h = rangePosition(mid, ticker.low, ticker.high);

  // Perp data.
  const premiumBps = mark.index > 0 ? ((mark.mark - mark.index) / mark.index) * 10_000 : 0;
  const fundingAgo = feed.fundingSamples.at(now - 60 * 60_000, (f) => f.ts);
  const oiNow = feed.oiSamples.last();
  const oi5m = feed.oiSamples.at(now - 5 * 60_000, (o) => o.ts);
  const oi30m = feed.oiSamples.at(now - 30 * 60_000, (o) => o.ts);

  const vol1m = realizedVolPct(closes, 20);
  const vol60 = realizedVolPct(closes, 60);

  const barrier = cfg.question.barrierPct;
  const state: SymbolState = {
    symbol: feed.symbol,
    ts: new Date(now).toISOString(),
    tier: liquidityTier(ticker.quoteVolume, cfg),
    daysSinceListing: round((now - feed.meta.onboardDate) / 86_400_000, 1),
    book: {
      mid: sig(mid),
      spreadBps: round(spread, 2),
      imbalanceTop5: round(imbalance, 3),
      depthUsd: {
        bps10: book.depthUsdWithin(10).map((x) => round(x, 0)) as [number, number],
        bps25: book.depthUsdWithin(25).map((x) => round(x, 0)) as [number, number],
        bps50: book.depthUsdWithin(50).map((x) => round(x, 0)) as [number, number],
      },
      bids: bids.map(([p, q]) => [sig(p), round(p * q, 0)]),
      asks: asks.map(([p, q]) => [sig(p), round(p * q, 0)]),
    },
    returnsPct: {
      s30: roundOrNull(pctChange(midAt(30_000), mid), 3),
      m1: roundOrNull(pctChange(midAt(60_000) ?? closeNBarsAgo(1), mid), 3),
      m5: roundOrNull(pctChange(midAt(5 * 60_000) ?? closeNBarsAgo(5), mid), 3),
      m15: roundOrNull(pctChange(midAt(15 * 60_000) ?? closeNBarsAgo(15), mid), 3),
      h1: roundOrNull(pctChange(closeNBarsAgo(60), mid), 3),
    },
    trades: {
      count1m: t1m.length,
      buyUsd1m: round(buy1m, 0),
      sellUsd1m: round(sell1m, 0),
      cvdUsd1m: round(buy1m - sell1m, 0),
      cvdUsd5m: round(sumUsd(t5m, true) - sumUsd(t5m, false), 0),
      vwap1m: vwap(t1m) === null ? null : sig(vwap(t1m)!),
      vwap5m: vwap5m === null ? null : sig(vwap5m),
      vwapDistBps5m: vwap5m === null ? null : round(((mid - vwap5m) / vwap5m) * 10_000, 1),
      largestUsd1m: round(largest1m, 0),
      recent,
    },
    indicators1m: {
      sma20: sma(closes, 20) === null ? null : sig(sma(closes, 20)!),
      sma50: sma(closes, 50) === null ? null : sig(sma(closes, 50)!),
      ema20: ema(closes, 20) === null ? null : sig(ema(closes, 20)!),
      rsi14: roundOrNull(rsi(closes, 14), 1),
      realizedVolPct1m: roundOrNull(vol1m, 3),
      realizedVolPct5m: vol60 === null ? null : round(vol60 * Math.sqrt(5), 3),
      rangePos1h: roundOrNull(rangePos1h, 2),
      rangePos24h: roundOrNull(rangePos24h, 2),
      range5mPct: roundOrNull(range5mPct, 3),
    },
    perp: {
      mark: sig(mark.mark),
      premiumBps: round(premiumBps, 1),
      fundingRatePct: round(mark.fundingRate * 100, 4),
      fundingIntervalHours: feed.meta.fundingIntervalHours,
      minsToFunding: round((mark.nextFundingTime - now) / 60_000, 0),
      fundingChange1hPct: fundingAgo ? round((mark.fundingRate - fundingAgo.rate) * 100, 4) : null,
      oiUsd: oiNow ? round(oiNow.oi * mark.mark, 0) : null,
      oiChangePct5m: oiNow && oi5m ? roundOrNull(pctChange(oi5m.oi, oiNow.oi), 2) : null,
      oiChangePct30m: oiNow && oi30m ? roundOrNull(pctChange(oi30m.oi, oiNow.oi), 2) : null,
    },
    daily: {
      quoteVolumeUsd: round(ticker.quoteVolume, 0),
      changePct: round(ticker.priceChangePct, 2),
      distFromHighPct: ticker.high > 0 ? round(((ticker.high - mid) / ticker.high) * 100, 2) : 0,
      distFromLowPct: ticker.low > 0 ? round(((mid - ticker.low) / ticker.low) * 100, 2) : 0,
    },
    barrier: {
      upPct: barrier,
      downPct: barrier,
      horizonMin: cfg.question.horizonMs / 60_000,
      roundTripCostBps: roundTripCostBps(cfg),
    },
  };
  return state;
}
