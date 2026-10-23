import { describe, expect, it } from "vitest";
import { Labeler } from "../src/labeler/labeler.js";
import type { LabelRow } from "../src/ledger/db.js";

function setup() {
  const labels: LabelRow[] = [];
  const l = new Labeler((row) => labels.push(row));
  l.track(1, "X", 1000, 100, 0.5, 60_000); // up 100.5, down 99.5, deadline 61000
  return { l, labels };
}

describe("Labeler", () => {
  it("labels up_first when a print reaches the up barrier before the down barrier", () => {
    const { l, labels } = setup();
    l.onTrade("X", 2000, 100.2);
    l.onTrade("X", 3000, 99.6);
    l.onTrade("X", 4000, 100.5);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ stateId: 1, outcome: "up_first", hitTs: 4000, hitPx: 100.5 });
    expect(labels[0]!.maxDownPct).toBeCloseTo(0.4);
    expect(l.pendingCount).toBe(0);
  });

  it("labels down_first and ignores prints from before the decision", () => {
    const { l, labels } = setup();
    l.onTrade("X", 500, 50); // before ts: ignored
    l.onTrade("X", 2000, 99.5);
    expect(labels[0]!.outcome).toBe("down_first");
  });

  it("labels neither at the deadline and records forward mids", () => {
    const { l, labels } = setup();
    l.onTick("X", 5000, 100.1);
    l.onTick("X", 11_000, 100.2);
    l.onTick("X", 31_000, 100.3);
    l.onTick("X", 60_999, 100.4);
    expect(labels).toHaveLength(0);
    l.onTick("X", 61_000, 100.45);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ outcome: "neither", mid10s: 100.2, mid30s: 100.3, mid60s: 100.45, mid300s: null });
  });

  it("does not resolve from prints after the deadline", () => {
    const { l, labels } = setup();
    l.onTrade("X", 70_000, 101);
    expect(labels).toHaveLength(0);
    l.flushAsLost(80_000);
    expect(labels[0]!.outcome).toBe("lost");
  });
});
