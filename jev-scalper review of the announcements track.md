# jev-scalper: review of the announcements track

Oct 25, 2026 · @Cesar

Jev ranks Binance announcements better than the rule, but the money result rests on three events. The verdict and forward-test plan hold, with a few corrections and one missing check.

## Small inconsistencies

- **Event counts don't add up.** The year breakdown sums to 816, not 819, and the kind table sums to 810 (the 7 funding events aren't in it). Probably just reporting, but reconcile before the survivorship rerun so counts can be compared.
- **The recalibrated Brier win is tiny.** 0.151 against 0.156 is a 0.005 difference on about 410 test events. It needs a bootstrap interval before it counts as beating base rates. The AUC results are more convincing: 0.62 overall and 0.59 out of sample are each roughly 2.5 standard errors above chance.
- **The out-of-sample +8.1% is likely the same tail.** The test half's top decile is only about 41 events. If NEWT (+20.8%) is in it, that one event contributes about half of the mean. Report it with and without the best three events, as for the full sample.

## The missing check: a kind-only baseline

The current mock is too weak to compare against. The top decile is 43 promotions and 22 spot listings out of 82, while the mock ranks promotions as flat. Jev's ranking may mostly be "promotions and spot listings first."

The fair test ranks by event kind, using each kind's average reaction learned from the earlier half of the data, scored on the later half. Then check whether Jev ranks better **within** each kind.

If it doesn't, the edge is in sorting notices by type, which a cheap rule can learn, and Jev's value is only better kind labels. That's still useful, but it's a different claim.

## Execution will be harsher than the 0.30% cost

- **Speed matters a lot.** The top-decile mean drops from +4.33% to +2.57% between entering within 60 seconds and entering at +5 minutes. The first minutes carry much of the return.
- **Slippage at news spikes is far worse than 10 bps.** On a thin meme perp, a taker entry into a +6% first-hour jump could easily cost 1% or more. Rerun the top-decile table at 0.5%, 1% and 2% round-trip cost. Without the three best events, the +0.77% mean probably disappears at 1%.
- **Check what the publication timestamp means.** Promotions and futures listings run up about 1.4 to 1.9% in the day before. Some of that is insiders, but notices may also reach X or the app before the CMS timestamp. The live forward test should record when the poller first sees each notice.

## The forward test needs more events

At 2025's rate of about 280 Meme events a year, 100 new events takes around four months. The top quintile is only 20 of them, too few to judge a tail-driven result. Two ways to get more data sooner:

1. **Widen the universe to all USDⓈ-M perps** for the forward test. The question is whether Jev reads announcements usefully, and that mechanism isn't specific to memes. This could plausibly multiply the event rate several times over.
2. **Do the survivorship fix first.** It's cheap and historical, so it reports back within days. If the top-decile result doesn't survive adding dead tokens, the track can close without a four-month wait.

## Suggested order

- [ ] Reconcile event counts; re-report the out-of-sample result without the best three events
- [ ] Survivorship rerun with every removed Meme or USDⓈ-M token
- [ ] Kind-only baseline learned on the earlier half; compare Jev within each kind
- [ ] Cost sensitivity of the top decile at 0.5%, 1% and 2% round trip
- [ ] Write pass criteria, then start the live forward test, ideally on all perps
