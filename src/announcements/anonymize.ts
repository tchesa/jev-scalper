/** Strip the token's identity and explicit dates from a notice so an LLM-calibrated model cannot recall it. */
export function anonymizeText(text: string, base: string, perp: string, spot: string | null): string {
  let t = text;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const sym of [perp, spot ?? ""].filter(Boolean)) t = t.replace(new RegExp(esc(sym), "g"), "TOKENUSDT");
  t = t.replace(new RegExp(`(1000000|1000|1M)?${esc(base)}(?=USDT|USDC|BTC|BNB|FDUSD|/)`, "g"), "TOKEN");
  // Stand-alone mentions: case-insensitive for real names, skipped entirely for 1-2 letter tickers ("Plan B").
  if (base.length >= 3) t = t.replace(new RegExp(`(?<![A-Za-z0-9])(1000000|1000|1M)?${esc(base)}(?![A-Za-z0-9])`, "gi"), "TOKEN");
  else t = t.replace(new RegExp(`\\(${esc(base)}\\)`, "g"), "(TOKEN)");
  // "Project Name (TOKEN)" -> "Project (TOKEN)"
  t = t.replace(/([A-Z][A-Za-z0-9.&'\- ]{0,40})\s*\(TOKEN\)/g, "Project (TOKEN)");
  // Explicit dates and years; keep clock times so "launch at 08:00 (UTC)" semantics survive.
  t = t.replace(/\b20\d\d[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/g, "DATE");
  t = t.replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d\d\b/g, "DATE");
  t = t.replace(/\b20(19|2\d)\b/g, "YEAR");
  return t;
}
