import { describe, expect, it } from "vitest";
import { LocalBook } from "../src/binance/book.js";
import type { DepthEvent } from "../src/binance/ws.js";

const ev = (U: number, u: number, pu: number, b: Array<[string, string]> = [], a: Array<[string, string]> = []): DepthEvent => ({
  e: "depthUpdate", E: 1, T: 1, s: "X", U, u, pu, b, a,
});
const snap = { lastUpdateId: 100, eventTime: 1, bids: [["1.00", "10"], ["0.99", "5"]] as Array<[string, string]>, asks: [["1.01", "7"], ["1.02", "3"]] as Array<[string, string]> };

describe("LocalBook", () => {
  it("buffers events before the snapshot and applies the overlapping one first", () => {
    const book = new LocalBook();
    expect(book.applyEvent(ev(90, 95, 89))).toBe("buffered"); // stale, dropped later
    expect(book.applyEvent(ev(98, 102, 95, [["1.00", "12"]]))).toBe("buffered"); // U<=100<=u
    expect(book.applyEvent(ev(103, 105, 102, [], [["1.01", "0"]]))).toBe("buffered");
    expect(book.applySnapshot(snap)).toBe("applied");
    expect(book.synced).toBe(true);
    expect(book.bestBid()).toEqual([1.0, 12]);
    expect(book.bestAsk()).toEqual([1.02, 3]);
  });

  it("drops events older than the snapshot and desyncs on a gap", () => {
    const book = new LocalBook();
    book.applySnapshot(snap);
    expect(book.applyEvent(ev(50, 60, 49))).toBe("dropped");
    expect(book.applyEvent(ev(99, 101, 98))).toBe("applied");
    expect(book.applyEvent(ev(102, 103, 101))).toBe("applied");
    expect(book.applyEvent(ev(110, 111, 109))).toBe("desync"); // pu != 103
    expect(book.synced).toBe(false);
    expect(book.resyncs).toBe(1);
    expect(book.applyEvent(ev(112, 113, 111))).toBe("buffered");
  });

  it("rejects a snapshot whose first buffered event does not overlap", () => {
    const book = new LocalBook();
    book.applyEvent(ev(105, 106, 104));
    expect(book.applySnapshot(snap)).toBe("desync");
    expect(book.synced).toBe(false);
  });

  it("computes mid, spread and depth within bps", () => {
    const book = new LocalBook();
    book.applySnapshot(snap);
    expect(book.mid()).toBeCloseTo(1.005);
    expect(book.spreadBps()).toBeCloseTo((0.01 / 1.005) * 10_000, 3);
    const [bid, ask] = book.depthUsdWithin(100); // within 1%: 1.00 and 0.995.. so only 1.00 bid; asks 1.01 only
    expect(bid).toBeCloseTo(10);
    expect(ask).toBeCloseTo(7.07);
  });
});
