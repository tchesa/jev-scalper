/** Pure, deterministic indicator math. No I/O, no Date.now(). */

export function sma(values: readonly number[], n: number): number | null {
  if (values.length < n || n <= 0) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i]!;
  return s / n;
}

/** EMA seeded with the SMA of the first n values, then standard recursion. */
export function ema(values: readonly number[], n: number): number | null {
  if (values.length < n || n <= 0) return null;
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += values[i]!;
  e /= n;
  for (let i = n; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

/** Wilder's RSI. */
export function rsi(closes: readonly number[], n = 14): number | null {
  if (closes.length < n + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/** Sample stdev of log returns over the last n bars, in percent per bar. */
export function realizedVolPct(closes: readonly number[], n: number): number | null {
  if (closes.length < n + 1 || n < 2) return null;
  const rets: number[] = [];
  for (let i = closes.length - n; i < closes.length; i++) rets.push(Math.log(closes[i]! / closes[i - 1]!));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * 100;
}

/** Where `price` sits in [low, high]: 0 at the low, 1 at the high. */
export function rangePosition(price: number, low: number, high: number): number | null {
  if (!(high > low)) return null;
  return Math.min(1, Math.max(0, (price - low) / (high - low)));
}

export function pctChange(from: number | null | undefined, to: number): number | null {
  if (from === null || from === undefined || from === 0) return null;
  return ((to - from) / from) * 100;
}

export function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function roundOrNull(x: number | null, digits: number): number | null {
  return x === null || !Number.isFinite(x) ? null : round(x, digits);
}

/** Significant-figure rounding for prices of wildly different magnitudes (1e-6 .. 1e5). */
export function sig(x: number, figs = 6): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  const d = Math.ceil(Math.log10(Math.abs(x)));
  return round(x, Math.max(0, figs - d));
}
