import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ann_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  base TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  grp TEXT NOT NULL DEFAULT 'meme',
  catalog TEXT,
  title TEXT NOT NULL,
  market TEXT,
  ret_h1 REAL, ret_h24 REAL, ret_m5 REAL, ret_m30 REAL, ret_h1_slow REAL,
  max_up_1h REAL, max_down_1h REAL, pre_h1 REAL, pre_h24 REAL, volume_ratio_1h REAL,
  label_h1 TEXT, label_h24 TEXT,
  state_json TEXT NOT NULL,
  seen_at INTEGER,          -- live poller: when the notice was first seen
  perp TEXT, spot TEXT, perp_onboard INTEGER,
  UNIQUE(code, base)
);
CREATE TABLE IF NOT EXISTS ann_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES ann_events(id),
  model TEXT NOT NULL,
  question_version TEXT NOT NULL,
  anonymized INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  latency_ms INTEGER,
  event_choice TEXT,
  p_h1_up REAL, p_h1_down REAL, p_h1_flat REAL,
  p_h24_up REAL, p_h24_down REAL, p_h24_flat REAL,
  novelty REAL,
  answers_json TEXT,
  input_tokens INTEGER,
  error TEXT,
  UNIQUE(event_id, model, question_version, anonymized)
);
`;

export class AnnLedger {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }
  close(): void {
    this.db.close();
  }
}
