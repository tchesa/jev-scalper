/**
 * Binance Vision public dumps (https://data.binance.vision) for USDⓈ-M perps.
 * Files are zipped CSVs, one per symbol-day, cached under data/binance-vision/.
 * Available for history: aggTrades, klines, markPriceKlines, premiumIndexKlines, metrics (5-min OI),
 * bookDepth (notional at ±1..5% every ~30 s). bookTicker dumps stopped in 2023, so there is no
 * historical best bid/ask; the replay book is a proxy built from prints.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { logger } from "../log.js";
import type { Kline } from "../types.js";

const log = logger("vision");
const BASE = "https://data.binance.vision/data/futures/um/daily";

export type Dataset = "aggTrades" | "klines" | "markPriceKlines" | "premiumIndexKlines" | "metrics" | "bookDepth";

export function datasetUrl(dataset: Dataset, symbol: string, day: string): string {
  switch (dataset) {
    case "klines":
    case "markPriceKlines":
    case "premiumIndexKlines":
      return `${BASE}/${dataset}/${symbol}/1m/${symbol}-1m-${day}.zip`;
    default:
      return `${BASE}/${dataset}/${symbol}/${symbol}-${dataset}-${day}.zip`;
  }
}

/** Download once into the cache directory; returns the local zip path or null on 404. */
export async function fetchDataset(dataset: Dataset, symbol: string, day: string, cacheDir: string): Promise<string | null> {
  const dir = `${cacheDir}/${dataset}`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${symbol}-${dataset}-${day}.zip`;
  if (existsSync(file) && statSync(file).size > 0) return file;
  const url = datasetUrl(dataset, symbol, day);
  const res = await fetch(url);
  if (res.status === 404) {
    log.warn("not available", { dataset, symbol, day });
    return null;
  }
  if (!res.ok || !res.body) throw new Error(`${url} -> ${res.status}`);
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  renameSync(tmp, file);
  log.info("downloaded", { dataset, symbol, day, mb: Math.round(statSync(file).size / 1048576) });
  return file;
}

/** Stream CSV rows out of a zip without unpacking to disk. Skips the header row. */
export async function* streamCsv(zipPath: string): AsyncGenerator<string[]> {
  const child = spawn("unzip", ["-p", zipPath], { stdio: ["ignore", "pipe", "inherit"] });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) {
      first = false;
      if (!/^\d/.test(line)) continue; // header
    }
    if (line.length) yield line.split(",");
  }
  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code} for ${zipPath}`))));
    if (child.exitCode !== null) child.exitCode === 0 ? resolve() : reject(new Error(`unzip exited ${child.exitCode}`));
  });
}

export async function readAll(zipPath: string | null): Promise<string[][]> {
  if (!zipPath) return [];
  const rows: string[][] = [];
  for await (const r of streamCsv(zipPath)) rows.push(r);
  return rows;
}

/** Shared layout of klines / markPriceKlines / premiumIndexKlines dumps. */
export function parseKlineRow(r: string[]): Kline {
  return {
    openTime: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    closeTime: Number(r[6]),
    quoteVolume: Number(r[7]),
    trades: Number(r[8]),
    takerBuyQuote: Number(r[10]),
    closed: true,
  };
}

export interface AggTradeRow {
  ts: number;
  price: number;
  qty: number;
  buyerTaker: boolean;
}

/** agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker */
export function parseAggTradeRow(r: string[]): AggTradeRow {
  return { ts: Number(r[5]), price: Number(r[1]), qty: Number(r[2]), buyerTaker: r[6] !== "true" && r[6] !== "True" };
}

export interface MetricsRow {
  ts: number;
  oi: number;
  oiUsd: number;
}

/** create_time,symbol,sum_open_interest,sum_open_interest_value,... (5-minute buckets, UTC "YYYY-MM-DD HH:MM:SS") */
export function parseMetricsRow(r: string[]): MetricsRow {
  return { ts: Date.parse(`${r[0]!.replace(" ", "T")}Z`), oi: Number(r[2]), oiUsd: Number(r[3]) };
}

export interface DepthRow {
  ts: number;
  pct: number; // -5..-1 bids, 1..5 asks
  notional: number;
}

/** timestamp,percentage,depth,notional */
export function parseDepthRow(r: string[]): DepthRow {
  return { ts: Date.parse(`${r[0]!.replace(" ", "T")}Z`), pct: Number(r[1]), notional: Number(r[3]) };
}

export function dayBefore(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function unlinkIfPartial(cacheDir: string): void {
  // Leftover .part files from an interrupted download are useless; remove them.
  for (const ds of ["aggTrades", "klines", "markPriceKlines", "premiumIndexKlines", "metrics", "bookDepth"]) {
    const dir = `${cacheDir}/${ds}`;
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".part")) unlinkSync(`${dir}/${f}`);
  }
}
