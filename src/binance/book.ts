import type { Level } from "../types.js";
import type { DepthEvent } from "./ws.js";
import type { DepthSnapshot } from "./rest.js";
import type { BookView } from "../market/feedView.js";

export type ApplyResult = "applied" | "dropped" | "buffered" | "desync";

/**
 * Local L2 book kept in sync per the Binance USDⓈ-M rules:
 *  - buffer events until a REST snapshot arrives
 *  - drop events with u < lastUpdateId
 *  - first applied event must satisfy U <= lastUpdateId <= u
 *  - every later event must have pu == previous u, else resync
 */
export class LocalBook implements BookView {
  readonly hasDepth = true;
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private sortedBids: Level[] | null = null;
  private sortedAsks: Level[] | null = null;
  private buffer: DepthEvent[] = [];
  private lastU = 0;
  private expectFirst = false;
  synced = false;
  lastEventTime = 0;
  resyncs = 0;

  /** Call when the socket reconnects or a gap is detected. Events buffer until the next snapshot. */
  reset(): void {
    this.synced = false;
    this.expectFirst = false;
    this.buffer = [];
    this.bids.clear();
    this.asks.clear();
    this.sortedBids = this.sortedAsks = null;
    this.lastU = 0;
  }

  applySnapshot(snap: DepthSnapshot): ApplyResult {
    this.bids.clear();
    this.asks.clear();
    for (const [p, q] of snap.bids) this.bids.set(Number(p), Number(q));
    for (const [p, q] of snap.asks) this.asks.set(Number(p), Number(q));
    this.sortedBids = this.sortedAsks = null;
    this.lastU = snap.lastUpdateId;
    this.lastEventTime = snap.eventTime;
    this.synced = true;
    this.expectFirst = true;
    const pending = this.buffer;
    this.buffer = [];
    for (const ev of pending) {
      const r = this.applyEvent(ev);
      if (r === "desync") return "desync";
    }
    return "applied";
  }

  applyEvent(ev: DepthEvent): ApplyResult {
    if (!this.synced) {
      this.buffer.push(ev);
      if (this.buffer.length > 5000) this.buffer.splice(0, this.buffer.length - 5000);
      return "buffered";
    }
    if (ev.u < this.lastU) return "dropped";
    if (this.expectFirst) {
      if (ev.U <= this.lastU && ev.u >= this.lastU) {
        this.expectFirst = false;
        this.applyLevels(ev);
        return "applied";
      }
      this.desync(ev);
      return "desync";
    }
    if (ev.pu !== this.lastU) {
      this.desync(ev);
      return "desync";
    }
    this.applyLevels(ev);
    return "applied";
  }

  private desync(ev: DepthEvent): void {
    this.resyncs++;
    this.reset();
    this.buffer.push(ev);
  }

  private applyLevels(ev: DepthEvent): void {
    for (const [p, q] of ev.b) {
      const qty = Number(q);
      if (qty === 0) this.bids.delete(Number(p));
      else this.bids.set(Number(p), qty);
    }
    for (const [p, q] of ev.a) {
      const qty = Number(q);
      if (qty === 0) this.asks.delete(Number(p));
      else this.asks.set(Number(p), qty);
    }
    this.sortedBids = this.sortedAsks = null;
    this.lastU = ev.u;
    this.lastEventTime = ev.E;
  }

  /** Bids descending by price. */
  getBids(): Level[] {
    if (!this.sortedBids) this.sortedBids = [...this.bids.entries()].sort((a, b) => b[0] - a[0]);
    return this.sortedBids;
  }

  /** Asks ascending by price. */
  getAsks(): Level[] {
    if (!this.sortedAsks) this.sortedAsks = [...this.asks.entries()].sort((a, b) => a[0] - b[0]);
    return this.sortedAsks;
  }

  bestBid(): Level | undefined {
    return this.getBids()[0];
  }
  bestAsk(): Level | undefined {
    return this.getAsks()[0];
  }

  mid(): number | null {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (!b || !a) return null;
    return (b[0] + a[0]) / 2;
  }

  spreadBps(): number | null {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (!b || !a) return null;
    const mid = (b[0] + a[0]) / 2;
    return ((a[0] - b[0]) / mid) * 10_000;
  }

  /** Notional (price*qty) resting within `bps` of mid on each side: [bid, ask]. */
  depthUsdWithin(bps: number): [number, number] {
    const mid = this.mid();
    if (mid === null) return [0, 0];
    const lo = mid * (1 - bps / 10_000);
    const hi = mid * (1 + bps / 10_000);
    let bid = 0;
    for (const [p, q] of this.getBids()) {
      if (p < lo) break;
      bid += p * q;
    }
    let ask = 0;
    for (const [p, q] of this.getAsks()) {
      if (p > hi) break;
      ask += p * q;
    }
    return [bid, ask];
  }
}
