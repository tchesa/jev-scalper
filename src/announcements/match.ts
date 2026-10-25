/**
 * Which announcements concern which meme contracts. A token matches when its base asset appears as a whole
 * word in the title, the body text or the detail's `pairs`, with a few guards against ordinary words.
 */
import type { ArticleDetail, ListedArticle } from "./fetch.js";

export interface TrackedAsset {
  base: string; // e.g. PEPE
  perp: string; // e.g. 1000PEPEUSDT
  spot: string | null; // e.g. PEPEUSDT when a spot pair exists
  perpOnboard: number; // ms; 0 when unknown
  /** Reporting group, e.g. "meme" or "dead". */
  group?: string;
  /** Match only pair-like or parenthesised forms (for tokens whose name is an ordinary word). */
  strict?: boolean;
}

/** Base assets that are also ordinary words; require an uppercase whole-word match plus a crypto cue. */
const AMBIGUOUS = new Set(["PEOPLE", "MEME", "BANK", "PUMP", "USELESS", "B", "M", "CAT", "BAN", "WHY", "BOB", "NEWT", "TOSHI", "MOG", "DOGS", "TRUMP", "MELANIA", "VINE", "HIPPO", "DEGEN", "SATS", "RATS", "BROCCOLI714", "BROCCOLIF3B", "BANANAS31", "GIGGLE", "TUT", "TST"]);
const CUE = /\b(token|contract|perpetual|trading pair|listing|delist|spot|futures|margin|leverage|funding|usdt|usdⓈ|usds|pair|alpha|launchpool|airdrop)\b/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-sensitive: "PEPE" but not "PEPECOIN" or "Pepe-like"; also the pair forms 1000PEPEUSDT, PEPE/USDT. */
export function tokenPattern(base: string): RegExp {
  const b = esc(base);
  // The quote must end the symbol: PUMPUSDT yes, PUMPBTCUSDT (a different contract) no.
  return new RegExp(`(?<![A-Za-z0-9])(?:(?:1000000|1000|1M)?${b}(?=(?:USDT|USDC|BTC|BNB|FDUSD)(?![A-Za-z0-9])|/)|${b}(?![A-Za-z0-9]))`);
}

/** Pair-like or parenthesised forms only: "(B)", "BUSDT", "B/USDT". Required for one- and two-letter tickers. */
function pairLikePattern(base: string): RegExp {
  const b = esc(base);
  return new RegExp(`(?<![A-Za-z0-9])(?:(?:1000000|1000|1M)?${b}(?:USDT|USDC|BTC|BNB|FDUSD|/USDT|/USDC)(?![A-Za-z0-9])|\\(${b}\\))`);
}

export function matchAssets(a: Pick<ListedArticle, "title"> & Partial<Pick<ArticleDetail, "text" | "pairs">>, assets: TrackedAsset[]): TrackedAsset[] {
  const title = a.title;
  const text = a.text ?? "";
  const pairs = (a.pairs ?? "") as string;
  const hay = `${title}\n${text}`;
  const out: TrackedAsset[] = [];
  for (const asset of assets) {
    const re = tokenPattern(asset.base);
    const pairLike = pairLikePattern(asset.base).test(hay) || (pairs.length > 0 && pairLikePattern(asset.base).test(pairs));
    let hit = pairLike || re.test(title) || re.test(text);
    if (hit && !pairLike && (asset.strict || asset.base.length <= 2 || AMBIGUOUS.has(asset.base))) {
      // Plain-word hits for ambiguous names need a crypto cue within 80 chars; one- and two-letter tickers need a pair form.
      if (asset.strict || asset.base.length <= 2) hit = false;
      else {
        const near = new RegExp(`(?<![A-Za-z0-9])${esc(asset.base)}(?![A-Za-z0-9])[^\\n]{0,80}`, "g");
        hit = [...hay.matchAll(near)].some((m) => CUE.test(m[0]));
      }
    }
    if (hit) out.push(asset);
  }
  return out;
}

/** Coarse event type from the title; Jev classifies finer, this is for the mock and for reporting. */
export type EventKind = "futures_listing" | "spot_listing" | "delisting" | "leverage_margin" | "funding" | "risk_tag" | "promotion" | "alpha" | "other";

export function eventKind(title: string): EventKind {
  const t = title.toLowerCase();
  if (/delist|removal of|will remove|cease|terminate|settle and delist/.test(t)) return "delisting";
  if (/perpetual|futures will launch|futures will list|usdⓈ-m|usds-m|coin-m/.test(t) && /launch|list|add/.test(t)) return "futures_listing";
  if (/leverage|margin tier|margin ratio|position limit|notional/.test(t)) return "leverage_margin";
  if (/funding rate|funding fee|settlement frequency|funding interval/.test(t)) return "funding";
  // "Binance Will List X with Seed Tag Applied" is a listing; a tag change alone is a risk-tag event.
  if (/will list|will add|new listing|listing of|lists|trading pair|vote to list/.test(t)) return "spot_listing";
  if (/monitoring tag|seed tag|risk warning/.test(t)) return "risk_tag";
  if (/binance alpha|alpha/.test(t)) return "alpha";
  if (/campaign|carnival|promotion|trade to share|rewards|competition|airdrop|launchpool|hodler/.test(t)) return "promotion";
  return "other";
}
