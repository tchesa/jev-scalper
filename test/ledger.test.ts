import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/db.js";
import { loadConfig } from "../src/config.js";
import { buildQuestion } from "../src/model/question.js";
import { sampleState } from "./model.test.js";

describe("Ledger", () => {
  it("round-trips states, decisions and labels", () => {
    const cfg = loadConfig({});
    const ledger = new Ledger(":memory:");
    ledger.insertRun("run", 1, {}, buildQuestion(cfg));
    const stateId = ledger.insertState({ runId: "run", roundId: "r1", ts: 1, state: sampleState(), horizonMs: 300_000, prefilterScore: 1.5 });
    expect(stateId).toBe(1);
    ledger.insertDecision({
      stateId,
      model: "mock",
      questionVersion: "tb-v1",
      ts: 2,
      output: { modelVersion: "mock-v1", latencyMs: 1, barriers: [] },
      barrier: { choice: "up_first", confidence: 0.2, probabilities: { up_first: 0.5, down_first: 0.3, neither: 0.2 } },
      error: null,
    });
    ledger.insertDecision({ stateId, model: "jev", questionVersion: "tb-v1", ts: 2, output: null, barrier: null, error: "APITimeoutError: timeout" });
    expect(ledger.unlabeledStateIds()).toEqual([1]);
    ledger.insertLabel({ stateId, outcome: "up_first", hitTs: 3, hitPx: 1.005, mid10s: 1.001, mid30s: null, mid60s: null, mid300s: null, maxUpPct: 0.5, maxDownPct: 0.1, labeledTs: 3 });
    expect(ledger.unlabeledStateIds()).toEqual([]);
    const row = ledger.db.prepare("SELECT d.p_up, d.error, l.outcome FROM decisions d JOIN labels l ON l.state_id = d.state_id WHERE d.model = 'mock'").get() as { p_up: number; error: null; outcome: string };
    expect(row).toEqual({ p_up: 0.5, error: null, outcome: "up_first" });
    ledger.close();
  });
});
