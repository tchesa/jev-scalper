import { getExchangeInfo, getFundingIntervals, getTickers24h } from "../binance/rest.js";
import type { Config } from "../config.js";
import type { SymbolMeta, Ticker24h } from "../types.js";
import { logger } from "../log.js";

const log = logger("universe");

export interface Universe {
  metas: Map<string, SymbolMeta>;
  tickers: Map<string, Ticker24h>;
  selected: string[];
}

/** True when the contract's Binance tags satisfy the configured include/exclude lists. */
export function tagsMatch(tags: string[], cfg: Config): boolean {
  const lower = tags.map((t) => t.toLowerCase());
  if (cfg.universe.excludeTags.some((t) => lower.includes(t))) return false;
  if (cfg.universe.tags.includes("*")) return true;
  return cfg.universe.tags.some((t) => lower.includes(t));
}

/**
 * USDT perpetuals matching the configured tags, inside the 24h quote-volume band, ranked by volume;
 * or an explicit SYMBOLS list. Funding intervals come from /fundingInfo (only non-8h contracts are listed).
 */
export async function loadUniverse(cfg: Config): Promise<Universe> {
  const [metasList, intervals, tickers] = await Promise.all([getExchangeInfo(), getFundingIntervals(), getTickers24h()]);
  const metas = new Map<string, SymbolMeta>();
  for (const m of metasList) {
    metas.set(m.symbol, { ...m, fundingIntervalHours: intervals.get(m.symbol) ?? 8 });
  }

  let selected: string[];
  if (cfg.universe.symbols.length) {
    selected = cfg.universe.symbols.filter((s) => {
      if (!metas.has(s)) log.warn("configured symbol not trading on Binance USDⓈ-M, skipping", { symbol: s });
      return metas.has(s);
    });
  } else {
    const maxVol = cfg.universe.maxQuoteVolume24h || Infinity;
    selected = [...metas.values()]
      .filter((m) => tagsMatch(m.tags, cfg) && !cfg.universe.excludeSymbols.includes(m.symbol))
      .map((m) => ({ m, vol: tickers.get(m.symbol)?.quoteVolume ?? 0 }))
      .filter((x) => x.vol >= cfg.universe.minQuoteVolume24h && x.vol <= maxVol)
      .sort((a, b) => b.vol - a.vol)
      .slice(0, cfg.universe.maxSymbols)
      .map((x) => x.m.symbol);
  }
  return { metas, tickers, selected };
}
