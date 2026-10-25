/**
 * Fill in reactions for live-polled events once 25 hours have passed, from REST 1-minute klines
 * (perp if it existed at publication, else spot). Idempotent; run from cron or by hand.
 *
 *   pnpm ann:label [--db data/announcements-live.sqlite]
 */
import { logger } from "../log.js";
import type { Kline } from "../types.js";
import { AnnLedger } from "./ledger.js";
import { H1_PCT, H24_PCT, impactLabel } from "./question.js";
import { measure } from "./reaction.js";

const log = logger("label");
function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
}

async function restKlines(symbol: string, market: "um" | "spot", fromMs: number, toMs: number): Promise<Kline[]> {
  const base = market === "um" ? "https://fapi.binance.com/fapi/v1/klines" : "https://api.binance.com/api/v3/klines";
  const out: Kline[] = [];
  let start = fromMs;
  while (start < toMs) {
    const res = await fetch(`${base}?symbol=${symbol}&interval=1m&startTime=${start}&endTime=${toMs}&limit=1000`);
    if (!res.ok) throw new Error(`${base} ${symbol} -> ${res.status}`);
    const rows = (await res.json()) as Array<[number, string, string, string, string, string, number, string, number, string, string, string]>;
    if (!rows.length) break;
    for (const r of rows) out.push({ openTime: r[0], open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]), closeTime: r[6], quoteVolume: Number(r[7]), trades: r[8], takerBuyQuote: Number(r[10]), closed: true });
    start = rows[rows.length - 1]![6] + 1;
    if (rows.length < 1000) break;
  }
  return out;
}

/** Measure every event older than 25 h that has no reaction yet. Returns how many were labeled. */
export async function labelDue(ledger: AnnLedger): Promise<{ due: number; done: number }> {
  const due = ledger.db.prepare("SELECT id, code, base, published_at, perp, spot, perp_onboard FROM ann_events WHERE ret_h1 IS NULL AND published_at < ?").all(Date.now() - 25 * 3_600_000) as Array<{ id: number; code: string; base: string; published_at: number; perp: string; spot: string | null; perp_onboard: number }>;
  const update = ledger.db.prepare("UPDATE ann_events SET market = ?, ret_h1 = ?, ret_h24 = ?, ret_m5 = ?, ret_m30 = ?, ret_h1_slow = ?, max_up_1h = ?, max_down_1h = ?, pre_h1 = ?, pre_h24 = ?, volume_ratio_1h = ?, label_h1 = ?, label_h24 = ? WHERE id = ?");
  let done = 0;
  for (const e of due) {
    const tries: Array<[string, "um" | "spot"]> = [];
    if (e.perp_onboard && e.perp_onboard <= e.published_at) tries.push([e.perp, "um"]);
    if (e.spot) tries.push([e.spot, "spot"]);
    if (!tries.length) tries.push([e.perp, "um"]);
    for (const [symbol, market] of tries) {
      try {
        const bars = await restKlines(symbol, market, e.published_at - 25 * 3_600_000, e.published_at + 25 * 3_600_000);
        const r = measure(bars, e.published_at, market, symbol);
        if (!r) continue;
        update.run(r.market, r.ret.h1, r.ret.h24, r.ret.m5, r.ret.m30, r.retSlow.h1, r.maxUp1h, r.maxDown1h, r.pre.h1, r.pre.h24, r.volumeRatio1h, impactLabel(r.ret.h1, H1_PCT), impactLabel(r.ret.h24, H24_PCT), e.id);
        done++;
        break;
      } catch (err) {
        log.warn("klines failed", { symbol, market, err });
      }
    }
  }
  if (due.length) log.info("labeled", { due: due.length, done });
  return { due: due.length, done };
}

async function main(): Promise<void> {
  const ledger = new AnnLedger(arg("db", "data/announcements-live.sqlite"));
  await labelDue(ledger);
  ledger.close();
}

// Run as a script only when invoked directly, so the poller can import labelDue.
if (process.argv[1] && /label\.ts$|label\.js$/.test(process.argv[1])) {
  main().catch((err) => {
    log.error("fatal", err);
    process.exit(1);
  });
}
