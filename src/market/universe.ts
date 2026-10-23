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

/**
 * Meme-tagged USDT perpetuals ranked by 24h quote volume, or an explicit SYMBOLS list.
 * Funding intervals come from /fundingInfo (only non-8h contracts are listed there).
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
    selected = [...metas.values()]
      .filter((m) => m.tags.some((t) => t.toLowerCase() === "meme"))
      .map((m) => ({ m, vol: tickers.get(m.symbol)?.quoteVolume ?? 0 }))
      .filter((x) => x.vol >= cfg.universe.minQuoteVolume24h)
      .sort((a, b) => b.vol - a.vol)
      .slice(0, cfg.universe.maxSymbols)
      .map((x) => x.m.symbol);
  }
  return { metas, tickers, selected };
}
