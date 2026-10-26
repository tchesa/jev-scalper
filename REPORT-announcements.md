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

## 6. Review checks (2026-10-25, after the track review)

Counts reconciled from the ledger: 819 events; by year 2019: 1, 2020: 5, 2021: 51, 2022: 27, 2023: 83,
2024: 260, 2025: 282, 2026: 110; the kind table in section 3 omitted funding (7), alpha (1) and one risk-tag row.

**Out of sample, properly.** Test half = the latest 410 events (2024-12-10 to 2026-10-20). Jev's top decile
(41 events): mean +8.1 %, bootstrap CI [0.7, 17.4], median +0.2 %; without its three best events (TUT +115 %,
GIGGLE +113 %, TRUMP +66 %): +1.0 %, CI [−2.1, 4.2]. The recalibration gain over base rates is 0.005 with CI
[−0.001, 0.011], so not established. The AUC is: 0.59 with CI [0.53, 0.68].

**The three outliers are real.** TUT and GIGGLE were spot-listing notices for tokens whose perp had launched
one to two weeks earlier; the perp moved 35 % to 56 % inside the publication minute on $5M to $10M of volume
and kept going (+32 % and +63 % even entering five minutes later). TRUMP's +66 % is the Jan 19 launch mania
attached to an Earn/Convert notice, not a reaction to it.

**Kind-only baseline.** Ranking test events by their title-kind's mean 1 h return learned on the earlier half
gives AUC 0.48 and a top decile of +1.0 % (−0.3 % without its best three). Ranking by Jev's own event label
the same way gives AUC 0.52. Jev's probability gives 0.59. Within kinds on the test half, Jev's AUC is 0.73 on
spot-listing titles (n 75), 0.75 on delistings (n 56), 0.87 on "other" (n 45), and chance on leverage/margin
(0.48, n 168) and promotions (0.44, n 37). So Jev does rank within kinds, not only between them.

**But one cheap rule captures the money.** A listing title ("Will List", "Vote to List results", not a margin,
Earn or Convert add-on, not a futures launch) for a token whose perp already existed at publication:

| set | n | mean 1 h | CI | median | > cost | mean at +5 min | without best 3 |
|---|---|---|---|---|---|---|---|
| listing rule, perp existed | 13 | +15.6 % | [−5, +42] | +1.4 % | 62 % | +7.2 % | −4.0 % |
| Jev top decile | 82 | +4.3 % | [0.7, 9.4] | +0.1 % | 41 % | +2.6 % | +0.8 % |
| Jev top decile excluding rule events | 81 | +1.3 % | [−0.5, 3.5] | +0.0 % | 41 % | +1.1 % | −0.1 % |
| everything outside the rule | 806 | −0.1 % | [−0.4, 0.3] | −0.1 % | 34 % | 0.0 % | |
| out of sample, rule | 10 | +19.6 % | [−7, +54] | +1.9 % | 70 % | +9.1 % | −6.7 % |
| out of sample, Jev top decile excluding rule | 40 | +1.8 % | [−2.4, 6.9] | −0.4 % | 35 % | +1.6 % | −1.3 % |

Jev puts 8 of the 13 rule events in its top decile (mean P(up) 0.36 on them vs 0.13 elsewhere), which is
where its top-decile return comes from. Outside those events its ranking has no money in it. Jev's reading is
not wrong: it labels 11 of the 13 "spot_listing" correctly and its AUC within the 13 is 0.78. It is just that
a regex finds the same 13.

**Cost sensitivity** (Jev top decile, full sample, mean net 1 h return): +4.0 % at 0.3 % cost, +3.3 % at 1 %,
+2.3 % at 2 %; without the best three: +0.5 %, −0.2 %, −1.2 %. At realistic news-spike slippage the ranking
outside the listing events loses money.

**Survivorship.** Binance has removed only 31 USDT perps outright in its history; delisted memes stay in
`exchangeInfo` as settling and were already tracked, so the meme list is nearly complete. The 31 dead contracts
(none obviously memes: LUNA, MATIC, EOS, SRM, ...) were run as a separate group with strict matching:
354 events, 244 measurable, on 30 tokens. Jev's 1 h AUC on this group is 0.62, the same as on memes, so the
classifier result replicates on tokens it never saw in the meme set. The money result does not: Jev's top
decile among dead tokens returned +0.6 % against +0.6 % for the rest, and the group contains no
listing-rule events (these tokens were listed on spot before their perps existed). Pooled with memes
(1,063 events) the top decile is +2.5 %, +0.5 % without its best three. The one large delisting reaction in
the data is LUNA on 2022-05-12 (−63 % in the hour), which Jev scored P(up) = 0.03. Survivorship was not
hiding a better result.

## 7. Verdict and the forward test

- Jev reads announcements well: event type, passing mentions, novelty, and a within-kind ranking that is
  real (AUC 0.59 out of sample, interval above 0.5). That is a classifier result, and it held on anonymized
  text.
- The tradeable effect in this data is the spot-listing pump on tokens that already trade as perps: 13 meme
  events in three years, median +1.4 %, fat tails both ways, and most of the move inside the first minute.
  A title rule finds them; Jev adds a cleaner label, not a better list.
- Everything else Jev ranks highly is noise after costs.

So the claim that survives is narrower than "Jev has edge on announcements": **speed on spot-listing notices
for perp-listed tokens is the edge, and Jev is an adequate but unnecessary classifier for them.** With 13 events
the size of that edge is unknown; the rule's interval includes zero.

## 7a. The listing rule across all perps (backfill, 2026-10-25)

The pre-registered 30-event forward test would take about 21 months at the observed rate (17 qualifying
notices in the last 12 months across all perps), so the rule was measured historically instead:
`pnpm ann:listings` opens every spot-listing notice in the archive (454 titles), keeps the tokens named in the
title whose USDⓈ-M perp already traded at publication, and measures the perp's reaction. Options, leveraged-token
and hard-fork notices are excluded. 44 events, 2023 to 2026, 11 meme and 33 other, 42 notices. Removed
contracts contributed none (all were listed on spot before their perps).

| entry | n | mean 1 h | CI | median | CI | > +1 % | < −1 % | without best 3 |
|---|---|---|---|---|---|---|---|---|
| within 60 s of publication | 44 | +6.8 % | [−0.1, 15.8] | +1.9 % | [−2.3, 6.6] | 55 % | 41 % | +0.9 % |
| five minutes later | 44 | +4.0 % | [0.0, 8.3] | +1.4 % | [−0.5, 6.4] | 50 % | 36 % | +1.4 % |
| 24 h | 44 | +0.1 % | [−9.7, 10.8] | −4.0 % | | 41 % | 57 % | |

What the 44 events say:

- **The move is front-run and fades.** Median +13 % in the hour before the notice and +16 % in the day before,
  volume 14× normal in the hour after, and a median 24 h return of −4 %. The notice confirms what the market
  already traded on; the first hour is the last leg.
- **Perp age is the variable.** Perps younger than 90 days at the notice (n 33): mean +10.2 % [1.4, 21.4],
  median +4.4 %, 64 % up more than 1 %, +2.5 % without the best three; slow entry +6.0 % [1.6, 11.3], median
  +4.4 %. Perps older than 90 days (n 11): mean −3.4 %, median −1.6 %, 27 % up. A listing of a token the
  market has traded for months is not news.
- **2025 was the year, 2026 is not.** Young-perp events in 2025 (n 15): median +6.6 % [1.4, 28.3], 87 % up.
  In 2026 (n 15): median −4.1 % [−11.6, 14.3], 53 % down more than 1 %; slow entry median +0.3 %. Binance now
  launches many perps as pre-market contracts days before the spot listing, so the listing is anticipated.
- **Jev's within-rule ranking is mostly perp age.** Its P(up) correlates −0.59 with log perp age, which it
  reads from the state field `perpListedDaysAgo`, and not at all with the prior move (−0.02). Within young
  perps, Jev's top half has median +6.2 % [1.0, 11.5] (slow +4.7 %) against +1.4 % for the bottom half, so it
  adds something beyond age, on 16 events, with an AUC interval [0.49, 0.83] that includes chance.
- **With a 5 % stop and 1 % cost**, young-perp events net a mean of +9.3 % but a median of 0.0 %, and 48 % hit
  the stop inside the hour.

Reading: the spot-listing pump on recently launched perps was real and large in 2025 and is at best marginal
in 2026. The historical mean is carried by a handful of events, the median is near costs in the latest year,
and half the trades hit a 5 % stop. This is the strongest effect found in the project and still not a trade.

Pre-registered forward test, revised (live poller running: `pnpm ann:poll`, all perps, feed lag recorded):

1. Rule v2: spot-listing title naming the token, perp already trading and younger than 90 days. No Jev in the
   rule. Expected rate about one event a month.
2. Measure on each live event: feed lag (first-seen minus publish time), 1 h return from the first full minute
   after detection, max drawdown in the hour, and Jev's P(up) ranking. 
3. Decision after 10 live rule-v2 events (roughly 8 to 10 months): proceed to a fill engine only if the median
   1 h return from detection is above +2 % and at most 3 of the 10 fall more than 1 %. A median below 0 on the
   first 6 closes the track early. Jev stays in the loop only if its top half beats its bottom half on those
   events; otherwise the rule alone goes forward.
4. No trading before then. The 2026 half of the backfill already fails criterion 3 (median −4.1 % fast,
   +0.3 % slow), which is the prior to hold.

## 8. Reproducing

```bash
pnpm ann:crawl && pnpm ann:events
pnpm ann:run -- --models jev,mock,random --anonymize true
pnpm ann:run -- --models jev --anonymize false
pnpm ann:eval -- --anonymized 1
pnpm ann:listings && pnpm ann:run -- --events data/announcements/events-listings.json --db data/announcements-listings.sqlite
```
