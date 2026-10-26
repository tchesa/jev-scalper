/**
 * Listing-rule backfill across every USDⓈ-M perpetual, alive or removed: open each spot-listing notice in the
 * archive, find the tokens it names, keep the ones whose perp already existed at publication, and measure the
 * reaction on that perp. Output has the same shape as events.json so `pnpm ann:run` can score it.
 *
 *   pnpm ann:listings [--cache data/announcements] [--vision data/binance-vision] [--out data/announcements/events-listings.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { logger } from "../log.js";
import type { AnnEvent } from "./events.js";
import { fetchDetail, type ListedArticle } from "./fetch.js";
import { eventKind, matchAssets, type TrackedAsset } from "./match.js";
import { reactionFor } from "./reaction.js";

const log = logger("listings");

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
}

/** The rule: a spot-listing title on the main exchange; not margin/earn/convert add-ons, not futures launches, not Alpha, not tokenized stocks. */
export function isListingTitle(title: string): boolean {
  return (
    /\b(will list|vote to list results|lists)\b/i.test(title) &&
    !/\b(margin|earn|convert|loans?|auto-invest|alpha|bstocks?|tokenized|securities)\b/i.test(title) &&
    !/^Binance Futures/i.test(title) &&
    !/perpetual/i.test(title)
  );
}

async function s3Prefixes(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let marker = "";
  for (;;) {
    const xml = await (await fetch(`https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix=${prefix}${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`)).text();
    const keys = [...xml.matchAll(/<(?:Prefix|Key)>([^<]+)<\/(?:Prefix|Key)>/g)].map((m) => m[1]!).filter((k) => k !== prefix);
    out.push(...keys);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !keys.length) break;
    marker = keys[keys.length - 1]!;
  }
  return out;
}

async function allPerps(): Promise<TrackedAsset[]> {
  const info = (await (await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo")).json()) as { symbols: Array<{ symbol: string; baseAsset: string; quoteAsset: string; contractType: string; onboardDate: number; underlyingSubType?: string[] }> };
  const spotKeys = await s3Prefixes("data/spot/daily/klines/");
  const spotSet = new Set(spotKeys.map((k) => k.replace("data/spot/daily/klines/", "").replace(/\/$/, "")));
  const strip = (b: string) => b.replace(/^(1000000|1000|1M)(?=[A-Z])/, "");
  const alive = info.symbols.filter((s) => s.quoteAsset === "USDT" && s.contractType === "PERPETUAL");
  const assets: TrackedAsset[] = alive.map((s) => {
    const base = strip(s.baseAsset);
    const meme = (s.underlyingSubType ?? []).some((t) => /meme/i.test(t));
    return { base, perp: s.symbol, spot: spotSet.has(`${base}USDT`) ? `${base}USDT` : null, perpOnboard: s.onboardDate, group: meme ? "meme" : "other", strict: true };
  });
  // Removed contracts: onboarding date = first daily kline file Binance Vision has for them.
  const aliveSet = new Set(alive.map((s) => s.symbol));
  const umKeys = await s3Prefixes("data/futures/um/daily/klines/");
  const dead = umKeys.map((k) => k.replace("data/futures/um/daily/klines/", "").replace(/\/$/, "")).filter((s) => /USDT$/.test(s) && !aliveSet.has(s) && !/_\d{6}$/.test(s));
  for (const sym of dead) {
    const files = await s3Prefixes(`data/futures/um/daily/klines/${sym}/1m/`);
    const first = files.map((f) => f.match(/-1m-(\d{4}-\d{2}-\d{2})\.zip$/)?.[1]).filter(Boolean).sort()[0];
    if (!first) continue;
    const base = strip(sym.replace(/USDT$/, ""));
    assets.push({ base, perp: sym, spot: spotSet.has(`${base}USDT`) ? `${base}USDT` : null, perpOnboard: Date.parse(`${first}T00:00:00Z`), group: "dead", strict: true });
  }
  return assets;
}

async function main(): Promise<void> {
  const cache = arg("cache", "data/announcements");
  const vision = arg("vision", "data/binance-vision");
  const out = arg("out", `${cache}/events-listings.json`);
  const index = JSON.parse(readFileSync(`${cache}/index.json`, "utf8")) as ListedArticle[];
  const notices = index.filter((a) => isListingTitle(a.title));
  const assets = await allPerps();
  log.info("loaded", { listingNotices: notices.length, assets: assets.length, dead: assets.filter((a) => a.group === "dead").length });

  const events: AnnEvent[] = [];
  let opened = 0;
  for (const a of notices) {
    const d = await fetchDetail(a, cache);
    opened++;
    const hits = matchAssets({ title: d.title, text: d.text, pairs: d.pairs }, assets);
    for (const asset of hits) {
      if (!(asset.perpOnboard > 0 && asset.perpOnboard < a.releaseDate)) continue; // the rule: perp already trading
      events.push({ code: d.code, title: d.title, text: d.text, catalog: d.firstCatalogName, publishedAt: d.releaseDate, base: asset.base, perp: asset.perp, spot: asset.spot, perpOnboard: asset.perpOnboard, group: asset.group ?? "other", kind: eventKind(d.title), assetsInNotice: hits.length, reaction: null });
    }
    if (opened % 50 === 0) log.info("opened", { opened, of: notices.length, events: events.length });
  }
  log.info("matched", { events: events.length, notices: new Set(events.map((e) => e.code)).size });
  let measured = 0;
  for (const e of events) {
    try {
      e.reaction = await reactionFor({ perp: e.perp, spot: null, perpOnboard: e.perpOnboard }, e.publishedAt, vision);
      if (e.reaction) measured++;
    } catch (err) {
      log.warn("reaction failed", { code: e.code, base: e.base, err });
    }
  }
  events.sort((a, b) => a.publishedAt - b.publishedAt);
  writeFileSync(out, JSON.stringify(events));
  const byGroup: Record<string, number> = {};
  for (const e of events) if (e.reaction) byGroup[e.group] = (byGroup[e.group] ?? 0) + 1;
  log.info("done", { events: events.length, measured, out, byGroup });
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
