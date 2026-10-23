import type { LabelRow, Outcome } from "../ledger/db.js";

export interface PendingLabel {
  stateId: number;
  symbol: string;
  ts: number;
  mid0: number;
  up: number;
  down: number;
  deadline: number;
  mids: { s10: number | null; s30: number | null; s60: number | null; s300: number | null };
  maxPx: number;
  minPx: number;
}

const OFFSETS: Array<[keyof PendingLabel["mids"], number]> = [
  ["s10", 10_000],
  ["s30", 30_000],
  ["s60", 60_000],
  ["s300", 300_000],
];

/**
 * Resolves the triple-barrier outcome for EVERY state (whether or not any model would have traded):
 * the first trade print at or beyond a barrier decides; the horizon expiring decides `neither`.
 * Forward mids at 10 s / 30 s / 60 s / 5 min are sampled from the live book.
 */
export class Labeler {
  private pending = new Map<string, PendingLabel[]>(); // by symbol

  constructor(private readonly onLabel: (row: LabelRow) => void) {}

  get pendingCount(): number {
    let n = 0;
    for (const v of this.pending.values()) n += v.length;
    return n;
  }

  track(stateId: number, symbol: string, ts: number, mid0: number, barrierPct: number, horizonMs: number): void {
    const p: PendingLabel = {
      stateId,
      symbol,
      ts,
      mid0,
      up: mid0 * (1 + barrierPct / 100),
      down: mid0 * (1 - barrierPct / 100),
      deadline: ts + horizonMs,
      mids: { s10: null, s30: null, s60: null, s300: null },
      maxPx: mid0,
      minPx: mid0,
    };
    const list = this.pending.get(symbol) ?? [];
    list.push(p);
    this.pending.set(symbol, list);
  }

  /** Feed every trade print; `ts` is the trade time. */
  onTrade(symbol: string, ts: number, price: number): void {
    const list = this.pending.get(symbol);
    if (!list?.length) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i]!;
      if (ts < p.ts) continue;
      if (ts > p.deadline) continue; // the tick will resolve it as neither
      if (price > p.maxPx) p.maxPx = price;
      if (price < p.minPx) p.minPx = price;
      if (price >= p.up) {
        list.splice(i, 1);
        this.resolve(p, "up_first", ts, price, ts);
      } else if (price <= p.down) {
        list.splice(i, 1);
        this.resolve(p, "down_first", ts, price, ts);
      }
    }
  }

  /** Call about once a second with the current mid for each symbol. */
  onTick(symbol: string, now: number, mid: number | null): void {
    const list = this.pending.get(symbol);
    if (!list?.length) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i]!;
      if (mid !== null) {
        for (const [key, off] of OFFSETS) {
          if (p.mids[key] === null && now >= p.ts + off) p.mids[key] = mid;
        }
      }
      if (now >= p.deadline) {
        list.splice(i, 1);
        this.resolve(p, "neither", null, null, now);
      }
    }
  }

  /** Mark everything still pending as lost (used on shutdown). */
  flushAsLost(now: number): void {
    for (const [, list] of this.pending) {
      for (const p of list) this.resolve(p, "lost", null, null, now);
      list.length = 0;
    }
  }

  private resolve(p: PendingLabel, outcome: Outcome, hitTs: number | null, hitPx: number | null, now: number): void {
    this.onLabel({
      stateId: p.stateId,
      outcome,
      hitTs,
      hitPx,
      mid10s: p.mids.s10,
      mid30s: p.mids.s30,
      mid60s: p.mids.s60,
      mid300s: p.mids.s300,
      maxUpPct: ((p.maxPx - p.mid0) / p.mid0) * 100,
      maxDownPct: ((p.mid0 - p.minPx) / p.mid0) * 100,
      labeledTs: now,
    });
  }
}
