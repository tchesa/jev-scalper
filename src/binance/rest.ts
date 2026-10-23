import { createHmac } from "node:crypto";
import type { Kline, SymbolMeta, Ticker24h } from "../types.js";
import { logger } from "../log.js";

const log = logger("rest");
const BASE = "https://fapi.binance.com";

export interface DepthSnapshot {
  lastUpdateId: number;
  eventTime: number;
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
}

async function get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]));
  const url = `${BASE}${path}${qs.size ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  const used = res.headers.get("x-mbx-used-weight-1m");
  if (used && Number(used) > 1800) log.warn("REST weight high", { used });
  return (await res.json()) as T;
}

export async function getExchangeInfo(): Promise<SymbolMeta[]> {
  interface Raw {
    symbols: Array<{
      symbol: string;
      baseAsset: string;
      quoteAsset: string;
      contractType: string;
      status: string;
      onboardDate: number;
      underlyingSubType?: string[];
      filters: Array<Record<string, string>>;
    }>;
  }
  const info = await get<Raw>("/fapi/v1/exchangeInfo");
  return info.symbols
    .filter((s) => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING")
    .map((s) => {
      const price = s.filters.find((f) => f["filterType"] === "PRICE_FILTER");
      const lot = s.filters.find((f) => f["filterType"] === "LOT_SIZE");
      return {
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        onboardDate: s.onboardDate,
        tickSize: Number(price?.["tickSize"] ?? "0"),
        stepSize: Number(lot?.["stepSize"] ?? "0"),
        fundingIntervalHours: 8,
        tags: s.underlyingSubType ?? [],
      };
    });
}

/** Only symbols with a non-default interval are listed; everything else settles every 8h. */
export async function getFundingIntervals(): Promise<Map<string, number>> {
  const rows = await get<Array<{ symbol: string; fundingIntervalHours: number }>>("/fapi/v1/fundingInfo");
  return new Map(rows.map((r) => [r.symbol, r.fundingIntervalHours]));
}

export async function getTickers24h(): Promise<Map<string, Ticker24h>> {
  interface Raw {
    symbol: string;
    lastPrice: string;
    priceChangePercent: string;
    highPrice: string;
    lowPrice: string;
    quoteVolume: string;
    volume: string;
    count: number;
  }
  const rows = await get<Raw[]>("/fapi/v1/ticker/24hr");
  return new Map(
    rows.map((r) => [
      r.symbol,
      {
        symbol: r.symbol,
        lastPrice: Number(r.lastPrice),
        priceChangePct: Number(r.priceChangePercent),
        high: Number(r.highPrice),
        low: Number(r.lowPrice),
        quoteVolume: Number(r.quoteVolume),
        volume: Number(r.volume),
        trades: r.count,
      },
    ]),
  );
}

export async function getDepthSnapshot(symbol: string, limit = 1000): Promise<DepthSnapshot> {
  const raw = await get<{ lastUpdateId: number; E: number; bids: Array<[string, string]>; asks: Array<[string, string]> }>(
    "/fapi/v1/depth",
    { symbol, limit },
  );
  return { lastUpdateId: raw.lastUpdateId, eventTime: raw.E, bids: raw.bids, asks: raw.asks };
}

export async function getKlines(symbol: string, interval = "1m", limit = 120): Promise<Kline[]> {
  type Row = [number, string, string, string, string, string, number, string, number, string, string, string];
  const rows = await get<Row[]>("/fapi/v1/klines", { symbol, interval, limit });
  const now = Date.now();
  return rows.map((r) => ({
    openTime: r[0],
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    closeTime: r[6],
    quoteVolume: Number(r[7]),
    trades: r[8],
    takerBuyQuote: Number(r[10]),
    closed: r[6] < now,
  }));
}

export async function getOpenInterest(symbol: string): Promise<{ ts: number; oi: number }> {
  const raw = await get<{ openInterest: string; time: number }>("/fapi/v1/openInterest", { symbol });
  return { ts: raw.time, oi: Number(raw.openInterest) };
}

export interface CommissionRate {
  makerBps: number;
  takerBps: number;
}

/** Signed endpoint: needs API key + secret with read permission. */
export async function getCommissionRate(symbol: string, apiKey: string, apiSecret: string): Promise<CommissionRate> {
  const params = new URLSearchParams({ symbol, timestamp: String(Date.now()), recvWindow: "5000" });
  const signature = createHmac("sha256", apiSecret).update(params.toString()).digest("hex");
  params.set("signature", signature);
  const res = await fetch(`${BASE}/fapi/v1/commissionRate?${params}`, { headers: { "X-MBX-APIKEY": apiKey } });
  if (!res.ok) throw new Error(`commissionRate -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  const raw = (await res.json()) as { makerCommissionRate: string; takerCommissionRate: string };
  return { makerBps: Number(raw.makerCommissionRate) * 10_000, takerBps: Number(raw.takerCommissionRate) * 10_000 };
}
