/**
 * Announcement evaluation: (a) what announcements do to meme prices, by kind, measured by code; (b) how well
 * each model's probabilities for the 1 h and 24 h reaction are calibrated, against base rates.
 *
 *   pnpm ann:eval [--db data/announcements.sqlite] [--anonymized 1|0]
 */
import { DatabaseSync } from "node:sqlite";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
}
const db = new DatabaseSync(arg("db", "data/announcements.sqlite"), { readOnly: true });
const anonymized = Number(arg("anonymized", "1"));
const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

interface Ev { id: number; kind: string; market: string; ret_h1: number; ret_h24: number | null; pre_h1: number | null; pre_h24: number | null; max_up_1h: number; max_down_1h: number; volume_ratio_1h: number | null; label_h1: string; label_h24: string | null }
const events = db.prepare("SELECT * FROM ann_events WHERE ret_h1 IS NOT NULL").all() as unknown as Ev[];
console.log(`events with a measured reaction: ${events.length}`);
console.log(`\nA. What announcements do (code-measured). Returns in %, medians; "pre" = move in the hour/day BEFORE publication.`);
console.log(`   kind                  n   ret1h  ret24h  |up1h| |dn1h|  pre1h  pre24h  vol x  up/flat/down at 1h`);
const kinds = [...new Set(events.map((e) => e.kind))].sort((a, b) => events.filter((e) => e.kind === b).length - events.filter((e) => e.kind === a).length);
for (const k of ["ALL", ...kinds]) {
  const es = k === "ALL" ? events : events.filter((e) => e.kind === k);
  if (!es.length) continue;
  const lab = (l: string) => es.filter((e) => e.label_h1 === l).length / es.length;
  console.log(`   ${k.padEnd(20)} ${String(es.length).padStart(4)}  ${f(med(es.map((e) => e.ret_h1)), 2).padStart(5)}  ${f(med(es.map((e) => e.ret_h24).filter((x): x is number => x !== null)), 2).padStart(6)}  ${f(med(es.map((e) => e.max_up_1h)), 2).padStart(5)}  ${f(med(es.map((e) => e.max_down_1h)), 2).padStart(5)}  ${f(med(es.map((e) => e.pre_h1).filter((x): x is number => x !== null)), 2).padStart(5)}  ${f(med(es.map((e) => e.pre_h24).filter((x): x is number => x !== null)), 2).padStart(6)}  ${f(med(es.map((e) => e.volume_ratio_1h).filter((x): x is number => x !== null)), 1).padStart(5)}  ${pct(lab("up"))}/${pct(lab("flat"))}/${pct(lab("down"))}`);
}

interface D { event_id: number; model: string; event_choice: string | null; p_h1_up: number; p_h1_down: number; p_h1_flat: number; p_h24_up: number | null; p_h24_down: number | null; p_h24_flat: number | null; novelty: number | null; latency_ms: number | null; input_tokens: number | null }
const decisions = db.prepare("SELECT * FROM ann_decisions WHERE error IS NULL AND anonymized = ?").all(anonymized) as unknown as D[];
const byId = new Map(events.map((e) => [e.id, e]));
const models = [...new Set(decisions.map((d) => d.model))].sort();
console.log(`\nB. Model calibration on the reaction (anonymized=${anonymized}). Base rates = Brier of predicting the realized class mix.`);
for (const horizon of ["h1", "h24"] as const) {
  const L = ["up", "down", "flat"] as const;
  console.log(`\n   ${horizon.toUpperCase()}  (threshold ±${horizon === "h1" ? 1 : 3}%)`);
  console.log(`   model    n    brier  base   logloss  argmax  AUC(up)  AUC(down) | mean P up/down/flat | realized`);
  for (const model of models) {
    const rows = decisions.filter((d) => d.model === model).map((d) => ({ d, e: byId.get(d.event_id)! })).filter(({ d, e }) => e && (horizon === "h1" ? e.label_h1 : e.label_h24) && (horizon === "h1" ? d.p_h1_up !== null : d.p_h24_up !== null));
    const n = rows.length;
    if (!n) continue;
    const p = (d: D): Record<string, number> => (horizon === "h1" ? { up: d.p_h1_up, down: d.p_h1_down, flat: d.p_h1_flat } : { up: d.p_h24_up!, down: d.p_h24_down!, flat: d.p_h24_flat! });
    const y = (e: Ev) => (horizon === "h1" ? e.label_h1 : e.label_h24!);
    const base: Record<string, number> = {};
    for (const l of L) base[l] = rows.filter(({ e }) => y(e) === l).length / n;
    let brier = 0, bb = 0, ll = 0, acc = 0;
    const mean = { up: 0, down: 0, flat: 0 };
    for (const { d, e } of rows) {
      const pp = p(d);
      for (const l of L) { const t = y(e) === l ? 1 : 0; brier += (pp[l]! - t) ** 2; bb += (base[l]! - t) ** 2; mean[l] += pp[l]! / n; }
      ll += -Math.log(Math.max(pp[y(e)]!, 1e-9));
      if (L.reduce((a, b) => (pp[a]! >= pp[b]! ? a : b)) === y(e)) acc++;
    }
    const auc = (label: string) => {
      const sc = rows.map(({ d }) => p(d)[label]!); const lb = rows.map(({ e }) => (y(e) === label ? 1 : 0));
      const idx = sc.map((_, i) => i).sort((a, b) => sc[a]! - sc[b]!); let rs = 0, pos = 0;
      for (let r = 0; r < idx.length; r++) if (lb[idx[r]!] === 1) { rs += r + 1; pos++; }
      const neg = idx.length - pos; return pos && neg ? (rs - (pos * (pos + 1)) / 2) / (pos * neg) : NaN;
    };
    console.log(`   ${model.padEnd(7)} ${String(n).padStart(4)}  ${f(brier / n)}  ${f(bb / n)}  ${f(ll / n)}   ${pct(acc / n).padStart(4)}   ${f(auc("up"))}    ${f(auc("down"))}   | ${f(mean.up, 2)} ${f(mean.down, 2)} ${f(mean.flat, 2)} | ${f(base.up!, 2)} ${f(base.down!, 2)} ${f(base.flat!, 2)}`);
  }
}
const jev = decisions.filter((d) => d.model === "jev");
if (jev.length) {
  console.log(`\nC. Jev's event classification vs the title rule, and novelty`);
  const agree: Record<string, Record<string, number>> = {};
  for (const d of jev) { const e = byId.get(d.event_id); if (!e) continue; (agree[e.kind] ??= {})[d.event_choice ?? "null"] = ((agree[e.kind] ??= {})[d.event_choice ?? "null"] ?? 0) + 1; }
  for (const [k, v] of Object.entries(agree)) console.log(`   ${k.padEnd(18)} -> ${Object.entries(v).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join("  ")}`);
  const nov = jev.map((d) => d.novelty).filter((x): x is number => x !== null);
  console.log(`   novelty: mean ${f(nov.reduce((a, b) => a + b, 0) / nov.length)}, share >0.5: ${pct(nov.filter((x) => x > 0.5).length / nov.length)}`);
  const lat = jev.map((d) => d.latency_ms).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const tok = jev.map((d) => d.input_tokens).filter((x): x is number => x !== null);
  console.log(`   latency p50 ${lat[Math.floor(lat.length / 2)]} ms, p95 ${lat[Math.floor(lat.length * 0.95)]} ms; input tokens mean ${Math.round(tok.reduce((a, b) => a + b, 0) / Math.max(tok.length, 1))}`);
}
