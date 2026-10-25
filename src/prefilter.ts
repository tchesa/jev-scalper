import type { Config } from "./config.js";
import type { FeedView } from "./market/feedView.js";

export interface PrefilterResult {
  pass: boolean;
  reasons: string[];
  /** Higher = more interesting; used to rank candidates when the per-round call cap binds. */
  score: number;
}

/** Cheap checks on raw feed data; runs for every symbol every round before any state is built. */
export function prefilter(feed: FeedView, cfg: Config, now: number): PrefilterResult {
  const reasons: string[] = [];
  if (!feed.isReady()) return { pass: false, reasons: ["not_ready"], score: 0 };
  if (!feed.isFresh(now)) reasons.push("stale");

  const spread = feed.book.spreadBps() ?? Infinity;
  if (spread > cfg.prefilter.maxSpreadBps) reasons.push(`spread_${spread.toFixed(1)}bps`);

  if (feed.book.hasDepth && cfg.prefilter.minDepth25BpsUsd > 0) {
    const [bid25, ask25] = feed.book.depthUsdWithin(25);
    if (Math.min(bid25, ask25) < cfg.prefilter.minDepth25BpsUsd) reasons.push("thin_depth_25bps");
  }

  const t1m = feed.trades.since(now - 60_000, (t) => t.ts);
  if (t1m.length < cfg.prefilter.minTrades1m) reasons.push(`few_trades_${t1m.length}`);

  const closed = feed.klines.filter((k) => k.closed).slice(-5);
  const mid = feed.book.mid() ?? 0;
  let range5mPct = 0;
  if (closed.length === 5 && mid > 0) {
    const hi = Math.max(...closed.map((k) => k.high));
    const lo = Math.min(...closed.map((k) => k.low));
    range5mPct = ((hi - lo) / mid) * 100;
    // In vol mode the barrier tracks the range, so this check only bites in fixed mode.
    if (cfg.question.barrierMode === "fixed" && range5mPct < cfg.prefilter.minRange5mVsBarrier * cfg.question.barrierPct) reasons.push("too_quiet");
  }

  const mid5mAgo = feed.mids.at(now - 5 * 60_000, (m) => m.ts)?.mid;
  const absRet5m = mid5mAgo ? Math.abs((mid - mid5mAgo) / mid5mAgo) * 100 : 0;
  const usd1m = t1m.reduce((a, t) => a + t.price * t.qty, 0);
  // Activity score: recent movement relative to the barrier plus log turnover.
  const score = absRet5m / cfg.question.barrierPct + range5mPct / cfg.question.barrierPct + Math.log10(1 + usd1m) / 10;

  return { pass: reasons.length === 0, reasons, score };
}
