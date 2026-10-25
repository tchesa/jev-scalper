# jev-scalper: review of milestone 1 results

Oct 25, 2026 · @Cesar

## Verdict

Jev showed no usable edge on the triple-barrier question. The report is sound: it followed the stop rule and controlled for wording (paired on identical states), regime (anonymized replay) and barrier size (volatility-scaled).

The arithmetic checks out, with one exception:

- **Cost per call is mislabeled.** Section 3.2 says $0.075 per call. At $0.042 per million input tokens, an 1,800-token call costs about $0.000075. The daily figure (\~$1.70 for about 23,000 calls) and the $4.30 total already use the correct number.
- The base-rate Brier scores for the long live session (0.202) and the replay (0.665) match the reported outcome mixes.
- 52.8% direction accuracy on a symmetric barrier yields about 5.6% of the barrier distance gross, matching the reported 6 to 11 bps.

## What the results mean

Jev behaves like a language model reading a chart, not a statistical forecaster:

- It follows strategy hints in the wording.
- It ignores volatility when judging whether a barrier is reachable.
- It has a fixed bearish lean across hours, symbols and regimes.
- Its only directional signal is 5-minute momentum, which a few lines of code reproduce.

The rule-based mock doesn't beat base rates either. So the conclusion is broader than "Jev is bad": 5-minute meme direction from these features may not be predictable after costs at all.

## Two final checks before closing the Jev path

Both run on the \~28,000 answers already in the ledger, so they need no new Jev calls.

1. **Separate bias from signal.** The bearish lean hurts calibration, which can be fixed after the fact. Discrimination can't. Split the Brier score into reliability and resolution, compute AUC for up-first versus down-first, and fit an isotonic or Platt recalibration on half the data, scored on the other half. If recalibrated Jev still can't beat base rates, the signal isn't there.
2. **Test whether Jev adds anything beyond the mock.** Fit a small logistic model on the mock's features, then on the same features plus Jev's probability, and compare out of sample. If adding Jev doesn't improve the score, it contributes nothing on top of momentum.

The report's suggested two-way direction probe is a cheap new run and worth doing too. Write its pass criteria down before running it, as the report's item 4 recommends.

## If the checks fail

That outcome is likely. Two directions make sense:

| Direction | What changes | Why it could work |
| --- | --- | --- |
| Use Jev to classify text, not prices | Jev labels Binance announcements (new listings, delistings, funding or leverage changes) and possibly news or social posts about Meme-tagged coins. Code measures the price reaction. | Listing effects are real but front-loaded, and Binance announces on short notice. A 300 ms classifier matters most there. |
| Keep the harness, drop Jev | Test funding-rate carry or cross-sectional momentum on the Meme universe through the same pipeline. | The streams, labeler, anonymized replay and evaluation are the valuable output of this milestone and work with any `Model`, with no inference cost. |

## Recommended next step

Run the two checks first, then choose a direction based on the results.

- [ ] Fix the cost-per-call figure in the report
- [ ] Brier decomposition, AUC and out-of-sample recalibration on existing ledger data
- [ ] Incremental-value test: mock features with and without Jev's probability
- [ ] Pre-register pass criteria, then run the two-way direction probe on the replay days
- [ ] Decide: Jev on announcements, or the harness without Jev
