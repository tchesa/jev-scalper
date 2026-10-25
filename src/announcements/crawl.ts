/** Crawl every catalog's article list into the cache. Safe to rerun; only page 1 is refetched. */
import { writeFileSync } from "node:fs";
import { CATALOGS, crawlCatalog, type ListedArticle } from "./fetch.js";
import { logger } from "../log.js";

const log = logger("crawl");
const cacheDir = process.argv[2] ?? "data/announcements";
const all: ListedArticle[] = [];
for (const id of Object.keys(CATALOGS).map(Number)) all.push(...(await crawlCatalog(id, cacheDir)));
all.sort((a, b) => a.releaseDate - b.releaseDate);
writeFileSync(`${cacheDir}/index.json`, JSON.stringify(all));
log.info("index written", { articles: all.length, from: new Date(all[0]!.releaseDate).toISOString().slice(0, 10), to: new Date(all[all.length - 1]!.releaseDate).toISOString().slice(0, 10) });
