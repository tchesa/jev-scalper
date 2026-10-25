/**
 * Signal diagnostics on existing ledgers, no model calls:
 *   1. Brier decomposition (reliability / resolution / uncertainty) per outcome, and AUC.
 *   2. Out-of-sample recalibration of the model's probabilities (multinomial logistic on log-probs;
 *      isotonic for the binary direction on hits). If recalibrated probabilities still lose to base
 *      rates, there is no discrimination to recover.
 *   3. Incremental value: a small multinomial logistic on the mock's input features, with and without
 *      the model's probabilities, scored out of sample.
 *
 *   pnpm signal -- --dbs data/a.sqlite,data/b.sqlite [--model jev] [--version tb-v2] [--split episode|time]
 *
 * "episode" split: alternate ledgers go to fold A/B (two-fold, both directions reported).
 * "time" split: first half of rows by timestamp trains, second half tests.
 */
import { DatabaseSync } from "node:sqlite";

type Outcome = "up_first" | "down_first" | "neither";
const O: Outcome[] = ["up_first", "down_first", "neither"];

interface Row {
  src: number;
  ts: number;
  y: number; // index in O
  p: [number, number, number];
  x: number[]; // mock-style features
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const dbs = (arg("dbs") ?? "").split(",").filter(Boolean);
if (!dbs.length) throw new Error("--dbs a.sqlite,b.sqlite required");
const model = arg("model", "jev")!;
const version = arg("version", "tb-v2")!;
const split = arg("split", dbs.length > 1 ? "episode" : "time")!;

const rows: Row[] = [];
dbs.forEach((path, src) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const rs = db
    .prepare(
      `SELECT s.ts, d.p_up, d.p_down, d.p_neither, l.outcome, s.barrier_pct b, s.state_json js
       FROM decisions d JOIN states s ON s.id = d.state_id JOIN labels l ON l.state_id = s.id
       WHERE d.model = ? AND d.question_version = ? AND d.error IS NULL AND l.outcome != 'lost'`,
    )
    .all(model, version) as Array<{ ts: number; p_up: number; p_down: number; p_neither: number; outcome: Outcome; b: number; js: string }>;
  for (const r of rs) {
    const j = JSON.parse(r.js);
    const b = r.b || 0.5;
    const turnover = Math.max((j.trades.buyUsd1m ?? 0) + (j.trades.sellUsd1m ?? 0), 1);
    const follow = j.tier === "large" || j.tier === "mid" ? 1 : -1;
    rows.push({
      src,
      ts: r.ts,
      y: O.indexOf(r.outcome),
      p: [r.p_up, r.p_down, r.p_neither ?? 0],
      x: [
        (j.returnsPct.m5 ?? 0) / b,
        (j.returnsPct.m1 ?? 0) / b,
        (j.returnsPct.s30 ?? 0) / b,
        (follow * (j.returnsPct.m5 ?? 0)) / b,
        (j.trades.cvdUsd1m ?? 0) / turnover,
        j.book.imbalanceTop5 ?? 0,
        ((j.indicators1m.rsi14 ?? 50) - 50) / 50,
        Math.log(Math.max(j.indicators1m.realizedVolPct5m ?? b, 1e-4) / b),
        (j.indicators1m.range5mPct ?? 0) / b,
        j.perp.oiChangePct5m ?? 0,
        (j.perp.premiumBps ?? 0) / 10,
        (j.daily.changePct ?? 0) / 10,
        (j.indicators1m.rangePos1h ?? 0.5) - 0.5,
      ],
    });
  }
});
if (!rows.length) throw new Error("no rows");
const f = (x: number) => x.toFixed(3);

// ---------- metrics ----------
function brier(ps: number[][], ys: number[]): number {
  let s = 0;
  for (let i = 0; i < ys.length; i++) for (let k = 0; k < 3; k++) s += (ps[i]![k]! - (ys[i] === k ? 1 : 0)) ** 2;
  return s / ys.length;
}
function logloss(ps: number[][], ys: number[]): number {
  let s = 0;
  for (let i = 0; i < ys.length; i++) s += -Math.log(Math.max(ps[i]![ys[i]!]!, 1e-9));
  return s / ys.length;
}
function baseRates(ys: number[]): number[] {
  const c = [0, 0, 0];
  for (const y of ys) c[y]! += 1;
  return c.map((v) => v / ys.length);
}
function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  let rankSum = 0;
  let pos = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]!] === scores[idx[i]!]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (labels[idx[k]!] === 1) rankSum += avgRank;
    i = j + 1;
  }
  for (const l of labels) if (l === 1) pos++;
  const neg = labels.length - pos;
  if (!pos || !neg) return NaN;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}
/** Murphy decomposition for one outcome with 10 probability bins. */
function decompose(ps: number[], ys: number[]): { brier: number; rel: number; res: number; unc: number } {
  const n = ps.length;
  const bins: Array<{ n: number; p: number; o: number }> = Array.from({ length: 10 }, () => ({ n: 0, p: 0, o: 0 }));
  let obar = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    const k = Math.min(9, Math.floor(ps[i]! * 10));
    bins[k]!.n++;
    bins[k]!.p += ps[i]!;
    bins[k]!.o += ys[i]!;
    obar += ys[i]!;
    b += (ps[i]! - ys[i]!) ** 2;
  }
  obar /= n;
  let rel = 0;
  let res = 0;
  for (const x of bins) {
    if (!x.n) continue;
    const pb = x.p / x.n;
    const ob = x.o / x.n;
    rel += x.n * (pb - ob) ** 2;
    res += x.n * (ob - obar) ** 2;
  }
  return { brier: b / n, rel: rel / n, res: res / n, unc: obar * (1 - obar) };
}

// ---------- models ----------
function standardizer(X: number[][]): (x: number[]) => number[] {
  const d = X[0]!.length;
  const mu = Array(d).fill(0);
  const sd = Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mu[j] += x[j]! / X.length;
  for (const x of X) for (let j = 0; j < d; j++) sd[j] += (x[j]! - mu[j]) ** 2 / X.length;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  return (x) => x.map((v, j) => Math.max(-5, Math.min(5, (v - mu[j]) / sd[j])));
}
/** Multinomial logistic regression, full-batch gradient descent with small L2. */
function fitSoftmax(X: number[][], ys: number[], iters = 400, lr = 0.5, l2 = 1e-3): (x: number[]) => number[] {
  const std = standardizer(X);
  const Z = X.map(std);
  const d = Z[0]!.length;
  const W: number[][] = Array.from({ length: 3 }, () => Array(d + 1).fill(0));
  const n = Z.length;
  const predict = (z: number[]) => {
    const logits = W.map((w) => w[d]! + z.reduce((a, v, j) => a + v * w[j]!, 0));
    const m = Math.max(...logits);
    const e = logits.map((l) => Math.exp(l - m));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / s);
  };
  for (let it = 0; it < iters; it++) {
    const G: number[][] = Array.from({ length: 3 }, () => Array(d + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const p = predict(Z[i]!);
      for (let k = 0; k < 3; k++) {
        const g = p[k]! - (ys[i] === k ? 1 : 0);
        for (let j = 0; j < d; j++) G[k]![j]! += g * Z[i]![j]!;
        G[k]![d]! += g;
      }
    }
    for (let k = 0; k < 3; k++) for (let j = 0; j <= d; j++) W[k]![j]! -= (lr * (G[k]![j]! / n + (j < d ? l2 * W[k]![j]! : 0)));
  }
  return (x) => predict(std(x));
}
/** Isotonic regression (pool adjacent violators) for a binary target; returns a step function. */
function fitIsotonic(scores: number[], ys: number[]): (s: number) => number {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  const blocks: Array<{ lo: number; hi: number; sum: number; n: number }> = [];
  for (const i of idx) {
    blocks.push({ lo: scores[i]!, hi: scores[i]!, sum: ys[i]!, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.sum / a.n <= b.sum / b.n) break;
      blocks.pop();
      blocks.pop();
      blocks.push({ lo: a.lo, hi: b.hi, sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  return (s) => {
    let v = blocks[0]!.sum / blocks[0]!.n;
    for (const b of blocks) if (s >= b.lo) v = b.sum / b.n;
    return v;
  };
}

// ---------- folds ----------
function folds(): Array<{ name: string; train: Row[]; test: Row[] }> {
  if (split === "episode") {
    const A = rows.filter((r) => r.src % 2 === 0);
    const B = rows.filter((r) => r.src % 2 === 1);
    return [
      { name: "train even-indexed ledgers, test odd", train: A, test: B },
      { name: "train odd-indexed ledgers, test even", train: B, test: A },
    ];
  }
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const half = Math.floor(sorted.length / 2);
  return [{ name: "train first half by time, test second half", train: sorted.slice(0, half), test: sorted.slice(half) }];
}

// ---------- report ----------
console.log(`rows ${rows.length} from ${dbs.length} ledger(s); model ${model} [${version}]; split ${split}`);
const ys = rows.map((r) => r.y);
const base = baseRates(ys);
console.log(`\n1. Decomposition (in-sample, all rows). Brier = reliability - resolution + uncertainty (+ within-bin term)`);
console.log(`   outcome      brier   reliability  resolution  uncertainty   AUC(outcome vs rest)`);
for (let k = 0; k < 3; k++) {
  const d = decompose(rows.map((r) => r.p[k]!), rows.map((r) => (r.y === k ? 1 : 0)));
  const a = auc(rows.map((r) => r.p[k]!), rows.map((r) => (r.y === k ? 1 : 0)));
  console.log(`   ${O[k]!.padEnd(11)}  ${f(d.brier)}   ${f(d.rel)}        ${f(d.res)}       ${f(d.unc)}        ${f(a)}`);
}
const hits = rows.filter((r) => r.y !== 2);
const dirScore = hits.map((r) => r.p[0]! / (r.p[0]! + r.p[1]!));
const dirY = hits.map((r) => (r.y === 0 ? 1 : 0));
console.log(`   direction on ${hits.length} hits: AUC(up vs down) ${f(auc(dirScore, dirY))}  (0.5 = no discrimination)`);
console.log(`   resolution is the part a recalibration cannot create; reliability is the part it can remove.`);

for (const fold of folds()) {
  const trY = fold.train.map((r) => r.y);
  const teY = fold.test.map((r) => r.y);
  const trBase = baseRates(trY);
  console.log(`\n2+3. Out of sample: ${fold.name}  (train ${fold.train.length}, test ${fold.test.length})`);
  const score = (name: string, ps: number[][]) => console.log(`   ${name.padEnd(42)} brier ${f(brier(ps, teY))}   logloss ${f(logloss(ps, teY))}`);
  score("base rates (from train)", fold.test.map(() => trBase));
  score(`${model} raw`, fold.test.map((r) => r.p));
  const recal = fitSoftmax(fold.train.map((r) => r.p.map((v) => Math.log(Math.max(v, 1e-4)))), trY);
  score(`${model} recalibrated (softmax on log-probs)`, fold.test.map((r) => recal(r.p.map((v) => Math.log(Math.max(v, 1e-4))))));
  const feat = fitSoftmax(fold.train.map((r) => r.x), trY);
  score("mock features only (logistic)", fold.test.map((r) => feat(r.x)));
  const both = fitSoftmax(fold.train.map((r) => [...r.x, ...r.p.map((v) => Math.log(Math.max(v, 1e-4)))]), trY);
  score(`mock features + ${model} probs (logistic)`, fold.test.map((r) => both([...r.x, ...r.p.map((v) => Math.log(Math.max(v, 1e-4)))])));
  // Direction on hits, out of sample.
  const trH = fold.train.filter((r) => r.y !== 2);
  const teH = fold.test.filter((r) => r.y !== 2);
  const ds = (r: Row) => r.p[0]! / (r.p[0]! + r.p[1]!);
  const iso = fitIsotonic(trH.map(ds), trH.map((r) => (r.y === 0 ? 1 : 0)));
  const teDirY = teH.map((r) => (r.y === 0 ? 1 : 0));
  const upRate = trH.filter((r) => r.y === 0).length / trH.length;
  const bin = (ps: number[]) => ps.reduce((a, p, i) => a + (p - teDirY[i]!) ** 2, 0) / ps.length;
  const acc = (ps: number[]) => ps.filter((p, i) => (p >= 0.5) === (teDirY[i] === 1)).length / ps.length;
  console.log(`   direction on ${teH.length} test hits:`);
  console.log(`     ${"base rate P(up|hit) from train".padEnd(40)} brier ${f(bin(teH.map(() => upRate)))}`);
  console.log(`     ${`${model} raw`.padEnd(40)} brier ${f(bin(teH.map(ds)))}   acc ${f(acc(teH.map(ds)))}   AUC ${f(auc(teH.map(ds), teDirY))}`);
  console.log(`     ${`${model} isotonic-recalibrated`.padEnd(40)} brier ${f(bin(teH.map((r) => iso(ds(r)))))}   acc ${f(acc(teH.map((r) => iso(ds(r)))))}`);
  const fd = fitSoftmax(trH.map((r) => r.x), trH.map((r) => (r.y === 0 ? 0 : 1)));
  const fdp = teH.map((r) => fd(r.x)[0]!);
  console.log(`     ${"mock features only (logistic)".padEnd(40)} brier ${f(bin(fdp))}   acc ${f(acc(fdp))}   AUC ${f(auc(fdp, teDirY))}`);
  const fb = fitSoftmax(trH.map((r) => [...r.x, Math.log(ds(r) / (1 - ds(r) + 1e-6) + 1e-6)]), trH.map((r) => (r.y === 0 ? 0 : 1)));
  const fbp = teH.map((r) => fb([...r.x, Math.log(ds(r) / (1 - ds(r) + 1e-6) + 1e-6)])[0]!);
  console.log(`     ${`mock features + ${model} direction`.padEnd(40)} brier ${f(bin(fbp))}   acc ${f(acc(fbp))}   AUC ${f(auc(fbp, teDirY))}`);
}
