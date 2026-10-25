/**
 * Price reaction around an announcement, measured from 1-minute bars (spot or perp, whichever existed).
 * p0 is the close of the bar containing the publish time, i.e. the price within 60 s of publication;
 * p0Slow is the open of the bar five minutes later, for a slow reader. All returns are in percent.
 * Pre-announcement context (returns over the prior 1 h and 24 h) is kept to detect front-running.
 */
import type { Kline } from "../types.js";
import { dayBefore, daysBetween, fetchDataset, parseKlineRow, readAll, type Market } from "../replay/vision.js";

export interface Reaction {
  market: Market;
  symbol: string;
  p0: number;
  p0Slow: number | null;
  ret: Record<"m5" | "m15" | "m30" | "h1" | "h4" | "h24", number | null>;
  retSlow: Record<"h1" | "h24", number | null>;
  maxUp1h: number;
  maxDown1h: number;
  pre: { h1: number | null; h24: number | null };
  volumeRatio1h: number | null; // quote volume in the hour after / hour before
  bars: number;
}

const H: Array<[keyof Reaction["ret"], number]> = [["m5", 5], ["m15", 15], ["m30", 30], ["h1", 60], ["h4", 240], ["h24", 1440]];

export async function loadBars(symbol: string, market: Market, fromMs: number, toMs: number, cacheDir: string): Promise<Kline[]> {
  const days = daysBetween(new Date(fromMs).toISOString().slice(0, 10), new Date(toMs).toISOString().slice(0, 10));
  const out: Kline[] = [];
  for (const d of days) {
    const zip = await fetchDataset("klines", symbol, d, cacheDir, market);
    if (zip) out.push(...(await readAll(zip)).map(parseKlineRow));
  }
  return out.sort((a, b) => a.openTime - b.openTime);
}

export function measure(bars: Kline[], publishMs: number, market: Market, symbol: string): Reaction | null {
  const i0 = bars.findIndex((k) => k.openTime <= publishMs && k.closeTime >= publishMs);
  if (i0 < 0) return null;
  const at = (minutes: number) => bars[i0 + minutes];
  const p0 = bars[i0]!.close;
  const pct = (p: number | undefined) => (p === undefined ? null : ((p - p0) / p0) * 100);
  const slow = at(5);
  const p0Slow = slow ? slow.open : null;
  const pctSlow = (p: number | undefined) => (p === undefined || p0Slow === null ? null : ((p - p0Slow) / p0Slow) * 100);
  const ret = {} as Reaction["ret"];
  for (const [k, m] of H) ret[k] = pct(at(m)?.close);
  const hour = bars.slice(i0 + 1, i0 + 61);
  const maxUp1h = hour.length ? ((Math.max(...hour.map((k) => k.high)) - p0) / p0) * 100 : 0;
  const maxDown1h = hour.length ? ((p0 - Math.min(...hour.map((k) => k.low))) / p0) * 100 : 0;
  const before = bars[i0 - 60];
  const before24 = bars[i0 - 1440];
  const volAfter = hour.reduce((a, k) => a + k.quoteVolume, 0);
  const volBefore = bars.slice(Math.max(0, i0 - 60), i0).reduce((a, k) => a + k.quoteVolume, 0);
  return {
    market,
    symbol,
    p0,
    p0Slow,
    ret,
    retSlow: { h1: pctSlow(at(60)?.close), h24: pctSlow(at(1440)?.close) },
    maxUp1h,
    maxDown1h,
    pre: { h1: before ? ((p0 - before.close) / before.close) * 100 : null, h24: before24 ? ((p0 - before24.close) / before24.close) * 100 : null },
    volumeRatio1h: volBefore > 0 && hour.length === 60 ? volAfter / volBefore : null,
    bars: bars.length,
  };
}

/** Try the perp first (if it existed at publish time), then spot. */
export async function reactionFor(asset: { perp: string; spot: string | null; perpOnboard: number }, publishMs: number, cacheDir: string): Promise<Reaction | null> {
  const from = publishMs - 25 * 3_600_000;
  const to = publishMs + 25 * 3_600_000;
  const tries: Array<[string, Market]> = [];
  if (asset.perpOnboard && asset.perpOnboard <= publishMs) tries.push([asset.perp, "um"]);
  if (asset.spot) tries.push([asset.spot, "spot"]);
  if (!tries.length) tries.push([asset.perp, "um"]); // onboard unknown: just try
  for (const [symbol, market] of tries) {
    const bars = await loadBars(symbol, market, from, to, cacheDir);
    const r = measure(bars, publishMs, market, symbol);
    if (r) return r;
  }
  return null;
}
export { dayBefore };
