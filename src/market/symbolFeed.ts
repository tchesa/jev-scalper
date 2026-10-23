import { LocalBook } from "../binance/book.js";
import type { AggTradeEvent, DepthEvent, KlineEvent, MarkPriceEvent } from "../binance/ws.js";
import { getDepthSnapshot, getKlines } from "../binance/rest.js";
import type { Kline, MarkUpdate, SymbolMeta, Ticker24h, Trade } from "../types.js";
import { Ring } from "./ring.js";
import { logger } from "../log.js";

const log = logger("feed");

export interface MidSample {
  ts: number;
  mid: number;
}

/** Everything the state builder and labeler need for one symbol, fed by streams + REST polls. */
export class SymbolFeed {
  readonly book = new LocalBook();
  readonly trades = new Ring<Trade>(5000);
  readonly mids = new Ring<MidSample>(3700); // ~1h at 1 sample/s
  readonly marks = new Ring<MarkUpdate>(4000);
  readonly fundingSamples = new Ring<{ ts: number; rate: number }>(200); // 1/min
  readonly oiSamples = new Ring<{ ts: number; oi: number }>(200); // 1 per poll
  klines: Kline[] = []; // closed 1m bars, oldest first, plus the live bar at the end
  ticker: Ticker24h | null = null;
  lastMark: MarkUpdate | null = null;
  private syncing = false;
  private lastFundingSampleTs = 0;

  constructor(readonly meta: SymbolMeta) {}

  get symbol(): string {
    return this.meta.symbol;
  }

  async bootstrap(): Promise<void> {
    this.klines = await getKlines(this.symbol, "1m", 120);
    await this.resyncBook();
  }

  async resyncBook(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const snap = await getDepthSnapshot(this.symbol, 1000);
        const r = this.book.applySnapshot(snap);
        if (r !== "desync") return;
        log.warn("snapshot did not line up with buffered events, retrying", { symbol: this.symbol, attempt });
        await new Promise((res) => setTimeout(res, 300 * (attempt + 1)));
      }
      log.error("book sync failed repeatedly", { symbol: this.symbol });
    } finally {
      this.syncing = false;
    }
  }

  onDepth(ev: DepthEvent): void {
    const r = this.book.applyEvent(ev);
    if (r === "desync") {
      log.warn("book desync, resyncing", { symbol: this.symbol, resyncs: this.book.resyncs });
      void this.resyncBook();
    }
  }

  onAggTrade(ev: AggTradeEvent): void {
    // m === true means the buyer was the maker, i.e. the aggressor sold.
    this.trades.push({ ts: ev.T, price: Number(ev.p), qty: Number(ev.q), buyerTaker: !ev.m });
  }

  onMark(ev: MarkPriceEvent): void {
    const u: MarkUpdate = {
      ts: ev.E,
      mark: Number(ev.p),
      index: Number(ev.i),
      fundingRate: Number(ev.r),
      nextFundingTime: ev.T,
    };
    this.lastMark = u;
    this.marks.push(u);
    if (ev.E - this.lastFundingSampleTs >= 60_000) {
      this.fundingSamples.push({ ts: ev.E, rate: u.fundingRate });
      this.lastFundingSampleTs = ev.E;
    }
  }

  onKline(ev: KlineEvent): void {
    const k = ev.k;
    const bar: Kline = {
      openTime: k.t,
      closeTime: k.T,
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
      quoteVolume: Number(k.q),
      trades: k.n,
      takerBuyQuote: Number(k.Q),
      closed: k.x,
    };
    const last = this.klines[this.klines.length - 1];
    if (last && last.openTime === bar.openTime) this.klines[this.klines.length - 1] = bar;
    else if (!last || bar.openTime > last.openTime) {
      this.klines.push(bar);
      if (this.klines.length > 1500) this.klines.splice(0, this.klines.length - 1500);
    }
  }

  onOpenInterest(ts: number, oi: number): void {
    this.oiSamples.push({ ts, oi });
  }

  /** Called by the 1 s sampler; also what the labeler reads forward mids from. */
  sampleMid(ts: number): void {
    const mid = this.book.synced ? this.book.mid() : null;
    if (mid !== null) this.mids.push({ ts, mid });
  }

  isReady(): boolean {
    return this.book.synced && this.book.mid() !== null && this.lastMark !== null && this.klines.length >= 60;
  }

  /** True when every stream has delivered something in the last `maxAgeMs`. */
  isFresh(now: number, maxAgeMs = 15_000): boolean {
    const lastTrade = this.trades.last();
    return (
      this.book.synced &&
      now - this.book.lastEventTime < maxAgeMs &&
      this.lastMark !== null &&
      now - this.lastMark.ts < maxAgeMs &&
      lastTrade !== undefined &&
      now - lastTrade.ts < 10 * 60_000
    );
  }
}
