import type { BookView, FeedView } from "../market/feedView.js";
import { Ring } from "../market/ring.js";
import type { Kline, Level, MarkUpdate, SymbolMeta, Ticker24h, Trade } from "../types.js";
import type { DepthRow, MetricsRow } from "./vision.js";

/**
 * Best bid/ask proxy from prints: a sell-aggressor print happened at the bid, a buy-aggressor print
 * at the ask. No L2 levels, so `hasDepth` is false and depth comes from the ±1% bookDepth dump.
 */
export class ReplayBook implements BookView {
  readonly synced = true;
  readonly hasDepth = false;
  private bid: { px: number; ts: number } | null = null;
  private ask: { px: number; ts: number } | null = null;
  private last: { px: number; ts: number } | null = null;
  depthPct1: [number, number] = [0, 0];

  constructor(private readonly tickSize: number) {}

  onTrade(ts: number, px: number, buyerTaker: boolean): void {
    if (buyerTaker) this.ask = { px, ts };
    else this.bid = { px, ts };
    this.last = { px, ts };
  }

  private quotes(): { bid: number; ask: number } | null {
    if (!this.last) return null;
    const fresh = (q: { px: number; ts: number } | null) => q && this.last!.ts - q.ts < 60_000 ? q.px : null;
    let bid = fresh(this.bid);
    let ask = fresh(this.ask);
    if (bid === null || ask === null || bid >= ask) {
      // Only one side seen recently, or quotes crossed because price moved: fall back to last print ± half a tick.
      const half = Math.max(this.tickSize, this.last.px * 1e-5) / 2;
      bid = this.last.px - half;
      ask = this.last.px + half;
    }
    return { bid, ask };
  }

  mid(): number | null {
    const q = this.quotes();
    return q ? (q.bid + q.ask) / 2 : null;
  }

  spreadBps(): number | null {
    const q = this.quotes();
    if (!q) return null;
    return ((q.ask - q.bid) / ((q.bid + q.ask) / 2)) * 10_000;
  }

  getBids(): Level[] {
    return [];
  }
  getAsks(): Level[] {
    return [];
  }

  depthUsdWithin(bps: number): [number, number] {
    return bps >= 100 ? this.depthPct1 : [0, 0];
  }
}

export interface FundingPoint {
  fundingTime: number;
  rate: number;
}

/**
 * A FeedView driven by a virtual clock. Everything is loaded up front except aggTrades, which stream;
 * `setClock(now)` releases only the bars, marks, OI and depth rows whose timestamps are <= now.
 */
export class ReplayFeed implements FeedView {
  readonly book: ReplayBook;
  readonly trades = new Ring<Trade>(5000);
  readonly mids = new Ring<{ ts: number; mid: number }>(3700);
  readonly fundingSamples = new Ring<{ ts: number; rate: number }>(200);
  readonly oiSamples = new Ring<{ ts: number; oi: number }>(500);
  klines: Kline[] = [];
  ticker: Ticker24h | null = null;
  lastMark: MarkUpdate | null = null;
  private now = 0;
  private iK = 0;
  private iMark = 0;
  private iPrem = 0;
  private iOi = 0;
  private iDepth = 0;
  private lastFundingSampleTs = 0;
  private lastPremium = 0;

  constructor(
    readonly meta: SymbolMeta,
    private readonly allKlines: Kline[], // closed 1m bars, sorted, covering warm-up + replay days
    private readonly markKlines: Kline[],
    private readonly premiumKlines: Kline[],
    private readonly metrics: MetricsRow[],
    private readonly depth: DepthRow[],
    private readonly funding: FundingPoint[], // settled rates, sorted by fundingTime
  ) {
    this.book = new ReplayBook(meta.tickSize);
  }

  get symbol(): string {
    return this.meta.symbol;
  }

  /** Advance the clock; releases historical rows up to `now` (inclusive). Monotone. */
  setClock(now: number): void {
    this.now = now;
    let newBar = false;
    while (this.iK < this.allKlines.length && this.allKlines[this.iK]!.closeTime <= now) {
      this.klines.push(this.allKlines[this.iK++]!);
      newBar = true;
    }
    if (this.klines.length > 1500) this.klines.splice(0, this.klines.length - 1500);
    while (this.iMark < this.markKlines.length && this.markKlines[this.iMark]!.closeTime <= now) this.iMark++;
    while (this.iPrem < this.premiumKlines.length && this.premiumKlines[this.iPrem]!.closeTime <= now) {
      this.lastPremium = this.premiumKlines[this.iPrem]!.close;
      this.iPrem++;
    }
    while (this.iOi < this.metrics.length && this.metrics[this.iOi]!.ts <= now) {
      const m = this.metrics[this.iOi++]!;
      this.oiSamples.push({ ts: m.ts, oi: m.oi });
    }
    while (this.iDepth < this.depth.length && this.depth[this.iDepth]!.ts <= now) {
      const d = this.depth[this.iDepth++]!;
      if (d.pct === -1) this.book.depthPct1 = [d.notional, this.book.depthPct1[1]];
      else if (d.pct === 1) this.book.depthPct1 = [this.book.depthPct1[0], d.notional];
    }
    if (newBar || !this.lastMark) this.refreshMark();
    if (newBar) this.refreshTicker();
  }

  private refreshMark(): void {
    const bar = this.iMark > 0 ? this.markKlines[this.iMark - 1] : undefined;
    if (!bar) return;
    const mark = bar.close;
    const index = mark / (1 + this.lastPremium);
    // Most recent settled funding rate (known at `now`) and the next settlement time.
    let rate = 0;
    let next = 0;
    for (const f of this.funding) {
      if (f.fundingTime <= this.now) rate = f.rate;
      else {
        next = f.fundingTime;
        break;
      }
    }
    this.lastMark = { ts: bar.closeTime, mark, index, fundingRate: rate, nextFundingTime: next || this.now + 8 * 3_600_000 };
    if (this.now - this.lastFundingSampleTs >= 60_000) {
      this.fundingSamples.push({ ts: this.now, rate });
      this.lastFundingSampleTs = this.now;
    }
  }

  /** Rolling 24h stats from closed bars, standing in for the live 24h ticker. */
  private refreshTicker(): void {
    const since = this.now - 86_400_000;
    const win = this.klines.filter((k) => k.closeTime > since);
    const first = win[0];
    const last = win[win.length - 1];
    if (!first || !last) return;
    this.ticker = {
      symbol: this.symbol,
      lastPrice: last.close,
      priceChangePct: ((last.close - first.open) / first.open) * 100,
      high: Math.max(...win.map((k) => k.high)),
      low: Math.min(...win.map((k) => k.low)),
      quoteVolume: win.reduce((a, k) => a + k.quoteVolume, 0),
      volume: win.reduce((a, k) => a + k.volume, 0),
      trades: win.reduce((a, k) => a + k.trades, 0),
    };
  }

  onTrade(ts: number, price: number, qty: number, buyerTaker: boolean): void {
    this.trades.push({ ts, price, qty, buyerTaker });
    this.book.onTrade(ts, price, buyerTaker);
  }

  sampleMid(ts: number): void {
    const mid = this.book.mid();
    if (mid !== null) this.mids.push({ ts, mid });
  }

  isReady(): boolean {
    return this.klines.length >= 60 && this.lastMark !== null && this.ticker !== null && this.book.mid() !== null;
  }

  isFresh(now: number): boolean {
    const t = this.trades.last();
    return t !== undefined && now - t.ts < 10 * 60_000;
  }
}
