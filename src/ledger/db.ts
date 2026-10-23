import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelOutput, QuestionSpec } from "../model/types.js";
import type { SymbolState } from "../types.js";

export type Outcome = "up_first" | "down_first" | "neither" | "lost";

export interface LabelRow {
  stateId: number;
  outcome: Outcome;
  hitTs: number | null;
  hitPx: number | null;
  mid10s: number | null;
  mid30s: number | null;
  mid60s: number | null;
  mid300s: number | null;
  maxUpPct: number | null;
  maxDownPct: number | null;
  labeledTs: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  started_ts INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  question_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  considered INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  queried INTEGER NOT NULL,
  rejects_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  mid REAL NOT NULL,
  tier TEXT NOT NULL,
  barrier_pct REAL NOT NULL,
  horizon_ms INTEGER NOT NULL,
  prefilter_score REAL NOT NULL,
  state_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS states_symbol_ts ON states(symbol, ts);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state_id INTEGER NOT NULL REFERENCES states(id),
  model TEXT NOT NULL,
  model_version TEXT,
  question_version TEXT NOT NULL,
  ts INTEGER NOT NULL,
  latency_ms INTEGER,
  choice TEXT,
  p_up REAL,
  p_down REAL,
  p_neither REAL,
  confidence REAL,
  regime TEXT,
  regime_probs_json TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS decisions_state ON decisions(state_id);
CREATE INDEX IF NOT EXISTS decisions_model ON decisions(model);
CREATE TABLE IF NOT EXISTS labels (
  state_id INTEGER PRIMARY KEY REFERENCES states(id),
  outcome TEXT NOT NULL,
  hit_ts INTEGER,
  hit_px REAL,
  mid_10s REAL,
  mid_30s REAL,
  mid_60s REAL,
  mid_300s REAL,
  max_up_pct REAL,
  max_down_pct REAL,
  labeled_ts INTEGER NOT NULL
);
`;

/** Append-only event ledger. Rows are inserted once and never updated. */
export class Ledger {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
  }

  insertRun(id: string, startedTs: number, config: unknown, question: QuestionSpec): void {
    this.db
      .prepare("INSERT INTO runs (id, started_ts, config_json, question_json) VALUES (?, ?, ?, ?)")
      .run(id, startedTs, JSON.stringify(config), JSON.stringify(question));
  }

  insertRound(row: { id: string; runId: string; ts: number; considered: number; passed: number; queried: number; rejects: Record<string, number> }): void {
    this.db
      .prepare("INSERT INTO rounds (id, run_id, ts, considered, passed, queried, rejects_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.runId, row.ts, row.considered, row.passed, row.queried, JSON.stringify(row.rejects));
  }

  insertState(row: { runId: string; roundId: string; ts: number; state: SymbolState; horizonMs: number; prefilterScore: number }): number {
    const r = this.db
      .prepare(
        `INSERT INTO states (run_id, round_id, ts, symbol, mid, tier, barrier_pct, horizon_ms, prefilter_score, state_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.runId,
        row.roundId,
        row.ts,
        row.state.symbol,
        row.state.book.mid,
        row.state.tier,
        row.state.barrier.upPct,
        row.horizonMs,
        row.prefilterScore,
        JSON.stringify(row.state),
      );
    return Number(r.lastInsertRowid);
  }

  insertDecision(row: { stateId: number; model: string; questionVersion: string; ts: number; output: ModelOutput | null; error: string | null }): void {
    const o = row.output;
    this.db
      .prepare(
        `INSERT INTO decisions (state_id, model, model_version, question_version, ts, latency_ms, choice, p_up, p_down, p_neither,
          confidence, regime, regime_probs_json, input_tokens, output_tokens, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.stateId,
        row.model,
        o?.modelVersion ?? null,
        row.questionVersion,
        row.ts,
        o?.latencyMs ?? null,
        o?.barrier.choice ?? null,
        o?.barrier.probabilities.up_first ?? null,
        o?.barrier.probabilities.down_first ?? null,
        o?.barrier.probabilities.neither ?? null,
        o?.barrier.confidence ?? null,
        o?.regime?.choice ?? null,
        o?.regime ? JSON.stringify(o.regime.probabilities) : null,
        o?.usage?.inputTokens ?? null,
        o?.usage?.outputTokens ?? null,
        row.error,
      );
  }

  insertLabel(l: LabelRow): void {
    this.db
      .prepare(
        `INSERT INTO labels (state_id, outcome, hit_ts, hit_px, mid_10s, mid_30s, mid_60s, mid_300s, max_up_pct, max_down_pct, labeled_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(l.stateId, l.outcome, l.hitTs, l.hitPx, l.mid10s, l.mid30s, l.mid60s, l.mid300s, l.maxUpPct, l.maxDownPct, l.labeledTs);
  }

  /** States that never got a label (e.g. the process died mid-horizon). */
  unlabeledStateIds(): number[] {
    const rows = this.db.prepare("SELECT s.id FROM states s LEFT JOIN labels l ON l.state_id = s.id WHERE l.state_id IS NULL").all() as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  close(): void {
    this.db.close();
  }
}
