# Jev on Binance announcements: implementation and first results

Written 2026-10-25, following the decision in the milestone-1 review to try Jev as a text classifier on Binance
announcements about Meme-tagged contracts, with code measuring the price reaction. Companion to
[REPORT.md](REPORT.md) (the price-state track, closed).

## 1. What was built (`src/announcements/`)

| piece | what it does |
|---|---|
| `fetch.ts`, `crawl.ts` | Crawl the seven announcement catalogs through the public CMS endpoints the Binance site uses (11,144 articles, 2017 to 2026) and fetch article bodies on demand. Bodies are a JSON node tree, flattened to text. Everything is cached. |
| `match.ts` | Decide which notices concern which meme contract: whole-word base asset in title, body or related pairs, including `1000PEPEUSDT` and `PEPE/USDT` forms, with guards for ambiguous names (PUMP, BANK, TRUMP, ...) and one-letter tickers (B, M). A coarse title rule gives a kind for reporting and for the mock. |
| `reaction.ts` | Price reaction from 1-minute bars (perp if it existed at publication, else spot): returns at 5 m / 15 m / 30 m / 1 h / 4 h / 24 h from the close of the publication minute, a slow-reader variant from 5 minutes later, first-hour excursions, the move in the prior hour and day, and the volume ratio after/before. |
| `anonymize.ts` | Replace the token, its pairs, the project name before "(TOKEN)", dates and years, so recall of a famous listing cannot pass as reading skill. |
| `question.ts` | `ann-v1`: what the notice does for the token (nine labels incl. passing mention), the 1 h reaction (±1 %), the 24 h reaction (±3 %), and a yes/no on novelty. State = notice text + which markets the token trades on. |
| `run.ts`, `ledger.ts`, `eval.ts` | Ask Jev, a rule-based mock (listings up, delistings down, rest flat) and a random baseline about every measured event; store next to the labels; report reactions by kind and model calibration. |

Tests: 55 passing across the repo. Cost of this track so far: about $0.16 of Jev credit (two passes over 819
events, about 2,000 input tokens each, p50 latency 236 ms).

## 2. Data

- Tracked: the 55 USDT perpetuals Binance tags `Meme` today, including 9 now settling. 24 have a spot pair.
- 2,981 candidate notices opened, 893 (notice, token) events across 528 notices, 819 with a measurable market
  at publication (815 on the perp, 4 on spot). 103 events sit inside batch notices listing more than five
  tokens.
- By year: 2021: 55, 2022: 24, 2023: 83, 2024: 259, 2025: 284, 2026: 111.
- Not measurable: 49 futures-listing notices for tokens with no spot pair (no market existed at publication),
  and any token delisted entirely before today (not in `exchangeInfo`). The second is a survivorship bias:
  tokens that died are missing, so listing reactions may be flattered.

## 3. What announcements do to meme prices (code-measured, no model)

Medians over 819 events; returns in percent from the publication minute.

| kind | n | 1 h | 24 h | max up 1 h | max down 1 h | prior 24 h | up / flat / down at 1 h (±1 %) |
|---|---|---|---|---|---|---|---|
| all | 819 | −0.08 | −0.21 | 0.81 | 0.85 | −0.08 | 20 / 59 / 21 |
| leverage or margin | 232 | −0.11 | −0.36 | 0.67 | 0.84 | −0.08 | 18 / 61 / 21 |
| other | 193 | −0.09 | −0.11 | 0.79 | 0.98 | −1.04 | 16 / 62 / 22 |
| spot listing | 171 | −0.10 | +0.54 | 0.93 | 0.81 | +0.48 | 22 / 57 / 22 |
| delisting | 85 | −0.03 | −0.19 | 0.53 | 0.48 | −0.70 | 8 / 73 / 19 |
| promotion | 83 | +0.06 | −1.73 | 1.43 | 0.84 | +1.91 | 35 / 45 / 20 |
| futures listing | 46 | +0.08 | +3.18 | 1.21 | 1.32 | +1.37 | 26 / 54 / 20 |

- **The typical announcement does nothing tradeable.** Median first-hour moves are a few tenths of a percent
  either way, inside a 17 to 30 bps round trip, and 59 % of events stay within ±1 %.
- **Listings are front-loaded**, as the handoff's research said: futures listings run +1.4 % in the day before
  and promotions +1.9 %. The seed-tag spot listings (BONK, WIF, BOME, TRUMP, CHEEMS/TST, MUBARAK) are the
  exception with large first-hour moves in both directions and 2 to 20× volume.
- **Delistings are already priced**: −0.7 % the day before, nothing after.

## 4. Jev on the reaction

819 events, anonymized states. Brier is three-class; base rates is the Brier of predicting the realized mix.

| horizon | model | Brier | base rates | argmax acc | AUC(up) | AUC(down) | mean P up / down / flat | realized |
|---|---|---|---|---|---|---|---|---|
| 1 h ±1 % | jev | 0.581 | 0.564 | 57 % | 0.62 | 0.55 | 0.14 / 0.24 / 0.62 | 0.20 / 0.21 / 0.59 |
| 1 h | mock | 0.638 | 0.564 | 45 % | 0.54 | 0.49 | | |
| 1 h | random | 0.828 | 0.564 | 35 % | 0.46 | 0.53 | | |
| 24 h ±3 % | jev | 0.807 | 0.661 | 41 % | 0.58 | 0.51 | 0.12 / 0.21 / 0.67 | 0.28 / 0.33 / 0.39 |
| 24 h | mock | 0.694 | 0.661 | 38 % | 0.54 | 0.52 | | |

Named (not anonymized) states: 1 h Brier 0.569, AUC(up) 0.61; 24 h Brier 0.781. Essentially the same as
anonymized, so Jev is not recalling the episodes.

Findings:

- **First real discrimination in this project.** AUC 0.62 for "up more than 1 % in an hour", 0.59 out of
  sample on the most recent half (time split), against 0.51 for the mock. Recalibrated out of sample, Jev
  beats base rates narrowly (Brier 0.151 vs 0.156 on the binary "up"). It beats the mock on every 1 h measure.
- **Still not calibrated**: it says "flat" 0.62 at 1 h (realized 0.59, fine) but 0.67 at 24 h where realized is
  0.39. Over a day, ±3 % is common for meme perps; Jev underestimates movement, the same pattern as the price
  track.
- **Per kind, the discrimination is concentrated**: delistings (AUC 0.80; Jev separates the few that bounce),
  spot listings (0.61), promotions (0.59). On leverage/margin batch notices it is 0.51, and it labels 43 of
  232 of those "passing mention", which is correct reading of a notice that lists 20 contracts.
- **Event classification** agrees with the title rule where the rule is good (futures listings 41/46, funding
  7/7, leverage 171/232) and overrides it where the rule is crude (it calls many "spot listing" titles
  product changes, and those move less). Jev's own `spot_listing` label marks 83 events with a mean 1 h
  return of +2.6 % and mean first-hour high of +6.2 %, versus +0.16 % for the title rule's 171.
- **Novelty** correlates mildly with reaction size: mean |1 h| 1.95 % when Jev says new (n 159) vs 1.37 % when
  it says routine (n 66).

## 5. Is the ranking worth money? Robustness of the top slices

Events sorted by Jev's P(up, 1 h); 1 h returns in percent; cost 0.30.

| slice | n | mean | 95 % bootstrap CI | median | 5 % trimmed mean | share > cost | share < −cost |
|---|---|---|---|---|---|---|---|
| top decile, enter within 60 s | 82 | +4.33 | [0.55, 9.08] | +0.07 | +1.08 | 41 % | 43 % |
| top decile, enter at +5 min | 82 | +2.57 | [0.29, 5.27] | −0.07 | +0.99 | 39 % | 45 % |
| top decile minus its 3 best events | 79 | +0.77 | [−0.54, 2.17] | −0.04 | +0.44 | 39 % | 44 % |
| top quintile | 164 | +1.77 | [−0.17, 4.40] | +0.06 | +0.24 | 43 % | 41 % |
| everything below the top decile | 737 | −0.29 | [−0.56, 0.01] | −0.09 | −0.10 | 33 % | 40 % |
| mock top decile | 82 | +0.03 | [−0.51, 0.59] | −0.03 | −0.04 | 28 % | 40 % |

Out of sample (latest 410 events as test): Jev's top decile averaged +8.1 % at 1 h against +0.4 % for the test
half, with 44 % of them up more than 1 %. Year by year, the Jev-ranked top quintile beats the rest on mean in
all six years but on median in only two. The top-decile events are mostly promotions (43 of 82), then spot
listings (22); the three best (NEWT +20.8 %, DOGE 2021 +8.6 %, BROCCOLI +6.2 %) carry the mean.

Reading: Jev's ranking selects announcements with a fatter right tail. The mean is positive and the interval
excludes zero at the 60-second entry, but the median is zero, nearly as many top-decile events lose more than
costs as gain more, and removing three events removes the result. This is a positive-skew lottery with
positive expectation on 82 draws, not a demonstrated edge. The mock's ranking, by contrast, is worthless.

## 6. Verdict and what would settle it

Jev reads announcements usefully (event type, passing mentions, novelty) and ranks them better than a rule, on
anonymized text, at 240 ms. The money question is open: a tail-driven +1 to +4 % mean in the top decile on a
few dozen events, with survivorship in the token list, is a lead, not a strategy.

Pre-registered forward test, to be written down before it starts:

1. **Fix survivorship.** Add every token that ever had a Meme tag or a USDⓈ-M contract and was later removed
   (from the delisting catalog), measure on whatever market existed. Rerun. Pass: top-decile mean 1 h return
   still above costs with the bootstrap interval excluding zero after removing the three best events.
2. **Live forward test, no trading.** Poll the CMS list endpoints every few seconds, ask Jev on publication,
   log P(up, 1 h) and the realized reaction from the live streams. Decision at 100 new events: top-quintile
   mean 1 h return above 0.5 % and median above zero, else close this track.
3. **Only then** the pessimistic fill engine from the original build order, on announcement events only:
   taker entry at the first print after the model answers, exit at 1 h or at a stop, real fees and funding.

What not to do: trade on the current ranking. The expected value may be positive, but the distribution says
most trades lose and a few pay for everything, and we have not seen enough of the few.

## 7. Reproducing

```bash
pnpm ann:crawl && pnpm ann:events
pnpm ann:run -- --models jev,mock,random --anonymize true
pnpm ann:run -- --models jev --anonymize false
pnpm ann:eval -- --anonymized 1
```
