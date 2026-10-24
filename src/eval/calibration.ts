/**
 * Calibration report over the ledger: Brier / log loss / skill vs climatology, reliability buckets,
 * per-tier breakdown, latency, and a rough after-cost expected value per threshold.
 * The EV number is NOT the fill engine: it assumes barrier hits pay exactly ±barrier and
 * `neither` exits at the 5-minute mid, minus the configured round-trip cost.
 *
 *   pnpm eval [--db path] [--min-n 30] [--since 2026-10-23]
 */
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../config.js";
import { roundTripCostBps } from "../state/builder.js";

interface Row {
  model: string;
  question_version: string;
  tier: string;
  symbol: string;
  mid: number;
  barrier_pct: number;
  p_up: number;
  p_down: number;
  p_neither: number;
  latency_ms: number | null;
  outcome: "up_first" | "down_first" | "neither";
  mid_300s: number | null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cfg = loadConfig({ ...process.env, MODELS: "mock" });
const dbPath = arg("db") ?? cfg.dbPath;
const minN = Number(arg("min-n") ?? 30);
const since = arg("since") ? Date.parse(arg("since")!) : 0;
const db = new DatabaseSync(dbPath, { readOnly: true });

const rows = db
  .prepare(
    `SELECT d.model, d.question_version, s.tier, s.symbol, s.mid, s.barrier_pct, d.p_up, d.p_down, d.p_neither, d.latency_ms, l.outcome, l.mid_300s
     FROM decisions d JOIN states s ON s.id = d.state_id JOIN labels l ON l.state_id = s.id
     WHERE d.error IS NULL AND l.outcome != 'lost' AND s.ts >= ?`,
  )
  .all(since) as unknown as Row[];

const totals = db
  .prepare(
    `SELECT
       (SELECT COUNT(*) FROM states) AS states,
       (SELECT COUNT(*) FROM labels WHERE outcome = 'lost') AS lost,
       (SELECT COUNT(*) FROM states s LEFT JOIN labels l ON l.state_id = s.id WHERE l.state_id IS NULL) AS pending,
       (SELECT COUNT(*) FROM decisions WHERE error IS NOT NULL) AS errors`,
  )
  .get() as { states: number; lost: number; pending: number; errors: number };

const fmt = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

function summarize(label: string, rs: Row[]): void {
  const n = rs.length;
  if (n === 0) return;
  const outcomes = ["up_first", "down_first", "neither"] as const;
  const base = Object.fromEntries(outcomes.map((o) => [o, rs.filter((r) => r.outcome === o).length / n])) as Record<(typeof outcomes)[number], number>;
  let brier = 0;
  let brierClim = 0;
  let logLoss = 0;
  let hits = 0;
  for (const r of rs) {
    const p = { up_first: r.p_up, down_first: r.p_down, neither: r.p_neither };
    for (const o of outcomes) {
      const y = r.outcome === o ? 1 : 0;
      brier += (p[o] - y) ** 2;
      brierClim += (base[o] - y) ** 2;
    }
    logLoss += -Math.log(Math.max(p[r.outcome], 1e-9));
    const argmax = outcomes.reduce((a, b) => (p[a] >= p[b] ? a : b));
    if (argmax === r.outcome) hits++;
  }
  brier /= n;
  brierClim /= n;
  logLoss /= n;
  const lat = rs.map((r) => r.latency_ms).filter((x): x is number => x !== null);
  console.log(`\n== ${label}  n=${n}`);
  console.log(`   base rates   up ${pct(base.up_first)}  down ${pct(base.down_first)}  neither ${pct(base.neither)}`);
  console.log(`   brier ${fmt(brier)}  (climatology ${fmt(brierClim)}, skill ${fmt(1 - brier / brierClim)})   logloss ${fmt(logLoss)}   argmax acc ${pct(hits / n)}`);
  if (lat.length) console.log(`   latency ms  p50 ${quantile(lat, 0.5)}  p95 ${quantile(lat, 0.95)}  max ${Math.max(...lat)}`);
}

function reliability(label: string, rs: Row[], pick: (r: Row) => number, isHit: (r: Row) => boolean): void {
  console.log(`   reliability for ${label}:  bin        n   predicted  observed`);
  for (let b = 0; b < 10; b++) {
    const lo = b / 10;
    const hi = (b + 1) / 10;
    const inBin = rs.filter((r) => pick(r) >= lo && (b === 9 ? pick(r) <= hi : pick(r) < hi));
    if (!inBin.length) continue;
    const predicted = inBin.reduce((a, r) => a + pick(r), 0) / inBin.length;
    const observed = inBin.filter(isHit).length / inBin.length;
    console.log(`                       ${lo.toFixed(1)}-${hi.toFixed(1)}  ${String(inBin.length).padStart(5)}   ${pct(predicted).padStart(7)}   ${pct(observed).padStart(7)}`);
  }
}

/** Rough after-cost EV: long if p_up>=t, short if p_down>=t; barrier hits pay ±barrier, neither exits at mid_300s. */
function naiveEv(rs: Row[], costBps: number): void {
  console.log(`   naive EV after ${costBps} bps round trip (NOT the fill engine):`);
  console.log(`     threshold  trades  win%   mean bps   total bps`);
  for (const t of [0.4, 0.45, 0.5, 0.55, 0.6, 0.7]) {
    let trades = 0;
    let wins = 0;
    let total = 0;
    for (const r of rs) {
      const dir = r.p_up >= t && r.p_up > r.p_down ? 1 : r.p_down >= t && r.p_down > r.p_up ? -1 : 0;
      if (dir === 0) continue;
      let grossBps: number;
      if (r.outcome === "up_first") grossBps = dir * r.barrier_pct * 100;
      else if (r.outcome === "down_first") grossBps = -dir * r.barrier_pct * 100;
      else if (r.mid_300s) grossBps = (dir * (r.mid_300s - r.mid)) / r.mid * 10_000;
      else continue;
      const net = grossBps - costBps;
      trades++;
      if (net > 0) wins++;
      total += net;
    }
    if (trades) console.log(`     ${t.toFixed(2).padStart(9)}  ${String(trades).padStart(6)}  ${pct(wins / trades).padStart(5)}  ${fmt(total / trades, 1).padStart(9)}  ${fmt(total, 0).padStart(10)}`);
  }
  console.log(`     never-trade: 0 bps`);
}

console.log(`ledger ${dbPath}: states ${totals.states}, labeled rows used ${rows.length}, lost ${totals.lost}, pending ${totals.pending}, model errors ${totals.errors}`);
const groups = [...new Set(rows.map((r) => `${r.model} [${r.question_version}]`))].sort();
const costBps = roundTripCostBps(cfg);
for (const model of groups) {
  const rs = rows.filter((r) => `${r.model} [${r.question_version}]` === model);
  summarize(model, rs);
  if (rs.length < minN) {
    console.log(`   (fewer than ${minN} labeled rows; buckets and EV skipped)`);
    continue;
  }
  reliability("P(up_first)", rs, (r) => r.p_up, (r) => r.outcome === "up_first");
  reliability("P(down_first)", rs, (r) => r.p_down, (r) => r.outcome === "down_first");
  naiveEv(rs, costBps);
  for (const tier of ["large", "mid", "small", "micro"]) {
    const t = rs.filter((r) => r.tier === tier);
    if (t.length >= minN) summarize(`${model} / tier ${tier}`, t);
  }
}
if (!groups.length) console.log("no labeled decisions yet; run the collector for at least one horizon");
