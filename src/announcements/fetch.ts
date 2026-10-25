/**
 * Binance announcement archive via the public CMS endpoints the website itself uses.
 * Lists are paged per catalog back to 2019; details carry the HTML body, publish time and related pairs.
 * Everything is cached under data/announcements/ as raw JSON so a crawl is never repeated.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { logger } from "../log.js";

const log = logger("ann");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const LIST = "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query";
const DETAIL = "https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query";

export const CATALOGS: Record<number, string> = {
  48: "New Cryptocurrency Listing",
  49: "Latest Binance News",
  93: "Latest Activities",
  161: "Delisting",
  157: "Maintenance Updates",
  51: "API Updates",
  128: "Crypto Airdrop",
};

export interface ListedArticle {
  id: number;
  code: string;
  title: string;
  releaseDate: number;
  catalogId: number;
}

export interface ArticleDetail extends ListedArticle {
  body: string; // HTML
  text: string; // body with tags stripped
  pairs: string | null;
  firstCatalogName: string | null;
  secondCatalogName: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string, attempt = 0): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 8) throw new Error(`${url} -> ${res.status}`);
    const wait = 3000 * 2 ** attempt;
    log.warn("throttled, backing off", { status: res.status, waitMs: wait });
    await sleep(wait);
    return getJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Bodies are either a JSON node tree ({"node":"root","child":[...]}) or legacy HTML. */
export function bodyToText(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      const out: string[] = [];
      const walk = (n: { node?: string; tag?: string; text?: string; child?: unknown[] }) => {
        if (n.node === "text" && typeof n.text === "string") out.push(n.text);
        if (Array.isArray(n.child)) for (const c of n.child) walk(c as typeof n);
        if (n.node === "element" && /^(p|div|li|tr|h\d|br|table)$/i.test(n.tag ?? "")) out.push("\n");
      };
      walk(JSON.parse(trimmed));
      return decodeEntities(out.join("")).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    } catch {
      /* fall through to HTML handling */
    }
  }
  return htmlToText(body);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Crawl one catalog's full list into the cache (one JSON per page). Returns all listed articles. */
export async function crawlCatalog(catalogId: number, cacheDir: string, delayMs = 1500): Promise<ListedArticle[]> {
  const dir = `${cacheDir}/lists/${catalogId}`;
  mkdirSync(dir, { recursive: true });
  const out: ListedArticle[] = [];
  for (let page = 1; page < 400; page++) {
    const file = `${dir}/page-${String(page).padStart(3, "0")}.json`;
    let data: { data: { catalogs: Array<{ total: number; articles: Array<Omit<ListedArticle, "catalogId">> }> } };
    // Page 1 is always refetched so new articles show up; deeper pages are stable and cached.
    if (page > 1 && existsSync(file)) data = JSON.parse(readFileSync(file, "utf8"));
    else {
      data = await getJson(`${LIST}?type=1&pageNo=${page}&pageSize=50&catalogId=${catalogId}`);
      writeFileSync(file, JSON.stringify(data));
      await sleep(delayMs);
    }
    const cat = data.data.catalogs[0];
    if (!cat || !cat.articles.length) break;
    for (const a of cat.articles) out.push({ id: a.id, code: a.code, title: a.title, releaseDate: a.releaseDate, catalogId });
    if (page * 50 >= cat.total) break;
  }
  log.info("catalog crawled", { catalogId, name: CATALOGS[catalogId], articles: out.length });
  return out;
}

export async function fetchDetail(a: ListedArticle, cacheDir: string, delayMs = 1200): Promise<ArticleDetail> {
  const dir = `${cacheDir}/details`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${a.code}.json`;
  let raw: { data: { body: string; publishDate: string | number | null; pairs: string | null; firstCatalogName: string | null; secondCatalogName: string | null } };
  if (existsSync(file)) raw = JSON.parse(readFileSync(file, "utf8"));
  else {
    raw = await getJson(`${DETAIL}?articleCode=${a.code}`);
    writeFileSync(file, JSON.stringify(raw));
    await sleep(delayMs);
  }
  const d = raw.data;
  return { ...a, body: d.body ?? "", text: bodyToText(d.body ?? ""), pairs: d.pairs ?? null, firstCatalogName: d.firstCatalogName ?? null, secondCatalogName: d.secondCatalogName ?? null };
}

export function cachedDetailCount(cacheDir: string): number {
  const dir = `${cacheDir}/details`;
  return existsSync(dir) ? readdirSync(dir).length : 0;
}
