# Jev meme-perp scalper: implementation report

Report on the handoff in [CLAUDE.md](CLAUDE.md), written 2026-10-25 as input to the next round of requirements.
Scope: build-order step 1 (streams, state builder, labeler, Jev logging only) on Binance meme perpetuals, and
what it measured. Every number comes from the SQLite ledgers under `data/` and is reproducible with
`pnpm eval` and `pnpm replay`.

## 1. What the handoff asked for

Goal: automated scalping of meme-coin USDⓈ-M perpetuals on Binance with TypeSafe's Jev as the signal
classifier. First milestone: not live trading but a paper-trading simulator on live mainnet data that measures
whether Jev has any edge after costs. Build order step 1: streams + state builder + labeler with Jev logging
only; measure calibration on the triple-barrier question first, and stop before building the rest if it is not
calibrated.

## 2. What was built

| Handoff requirement | Delivered | Notes |
|---|---|---|
| Market streams per symbol: depth@100ms synced to a REST snapshot, aggTrade, markPrice@1s, 1m klines; universe refresh from exchangeInfo + 24h ticker; mainnet only | yes | Two websocket connections are required (see 3.1). Universe selected by Binance's own `Meme` tag plus a 24h volume floor. |
| State builder: deterministic, one compact JSON per symbol, all math in code, the listed feature set | yes | ~2 KB, ~1,800 input tokens per call. Mid, spread, imbalance, depth at 10/25/50 bps and 1%, top-5 levels, returns over five windows, taker buy/sell/CVD/VWAP and recent prints, SMA20/50, EMA20, RSI14, realized vol, range position, funding, premium, OI and its change, 24h stats, liquidity tier, days since listing. Optional raw 1m bars. |
| Jev only for symbols passing cheap prefilters; triple-barrier question stating goal, horizon and cost; optional regime question; no bare labels | yes | Prefilters: freshness, spread cap, depth floor, trade-count floor, reachability. Two question wordings are kept, versioned (`tb-v1` with two strategy hints, `tb-v2` without). Regime question rides in the same request. |
| `Model` interface; Jev, rule-based mock and random swappable by config; baselines through the identical pipeline | yes | Mock encodes the handoff's fade-small/follow-large prior deterministically. Random is seeded. |
| Append-only ledger (SQLite) with exact state JSON, answers, probabilities, latency | yes | `runs`, `rounds`, `states`, `decisions`, `labels`. Node's built-in `node:sqlite`, no native build. Any decision can be replayed from its row. |
| Labeler for every Jev call, including rejected ones: barrier hit first, forward mids at 10 s / 30 s / 60 s / 5 min | yes | Resolves on real trade prints. States orphaned by a restart are marked `lost`, never inferred. |
| Evaluation: calibration buckets, Brier, baselines; Jev must beat the mock after costs | yes | Plus skill vs climatology (base rates), log loss, per-tier split, latency percentiles, a clearly labelled naive after-cost EV. PBO / Deflated Sharpe not needed yet: no configs were compared on P&L. |
| Fees from `/fapi/v1/commissionRate`, not hardcoded | yes when API keys are present | Falls back to configured defaults (maker 2 bps, taker 5 bps, slippage 10 bps per side) and logs it. |
| Risk gate, fill engine, ledger P&L, live executor (steps 2 to 4) | not built | By the handoff's own stop rule; see section 5. |

Added beyond the handoff because the measurements needed them:

- **Volatility-scaled barrier.** With a fixed 0.5% barrier, quiet hours produce 80 to 90% "neither" and the
  score measures predicting quiet. `BARRIER_MODE=vol` sets the barrier per state to a multiple of the realized
  move expected over the horizon, clamped to [0.3%, 3%]. Outcomes then split roughly a third each.
- **Historical replay.** The same builder, models, labeler and ledger driven by Binance Vision dumps through a
  virtual clock, with states anonymized (`PERP`, no timestamp) so a model calibrated on LLM answers cannot
  recall a famous episode. Needed because the live window was a quiet weekend with no selling regime.
- **Paired wordings.** Several question wordings answered in one Jev request, one ledger row each, so wording
  effects are measured on identical states.

42 unit tests and a clean typecheck; smoke-tested live on mainnet before every session.

## 3. Things learned while building

### 3.1 Binance
- In 2026 Binance split USDⓈ-M websocket market streams: depth and bookTicker on `/public/stream`, aggTrade,
  markPrice and kline on `/market/stream`. They cannot share a connection, and the legacy path silently drops
  the market streams. The handoff's single-connection picture no longer holds.
- Binance tags contracts with `underlyingSubType`; `Meme` gives a clean universe (46 USDT perps on 2026-10-23).
- Historical `bookTicker` dumps stopped in 2023. Historical top-of-book does not exist for free; replayed books
  are a proxy from the last sell-side and buy-side prints, and L2-only fields are omitted from replayed states.
- Many meme perps settle funding every 4 hours (`/fundingInfo` lists the non-8h ones), as the handoff warned.

### 3.2 Jev
- Latency: p50 280 to 300 ms, p95 350 ms, max ~720 ms from this machine. Fine for a 5-minute horizon,
  as the handoff expected. Transient connection errors ran at about 0.2% of calls; with retries disabled they
  are logged as error rows.
- Cost: about $0.000075 per call at 1,800 tokens ($0.042 per million input tokens), roughly $1.70 per day
  at the default 8 calls per 30 s. All experiments below, about 28,000 answered states, cost $4.30.
- Jev answers JSON state directly; no prompt-and-parse. The SDK's typed `choice` questions return a label, a
  full probability vector and a confidence, which is exactly what the ledger stores.

## 4. Results on meme perps

Scores are multi-class Brier, lower is better. "Base rates" is the Brier of always predicting the realized
outcome frequencies; a useful model must beat it. "Direction on hits" is the share of barrier hits on which
the model's up-versus-down lean was on the correct side.

### 4.1 Live sessions, fixed 0.5% barrier, 5-minute horizon

| session | window (UTC) | universe | wording | labeled Jev rows |
|---|---|---|---|---|
| L1 | 2026-10-24 16:00 to 16:50 | 11 meme perps | tb-v1 | 767 |
| L2 | 2026-10-24 19:16 to 20:16 | 11 meme perps | tb-v1 and tb-v2, paired | 602 each |
| L3 | 2026-10-24 21:02 to 2026-10-25 09:02 | 9 to 11 meme perps | tb-v2 | 7,685 |

| session | model | Brier | base rates |
|---|---|---|---|
| L1 | jev tb-v1 | 0.743 | 0.577 |
| L1 | mock | 0.684 | 0.577 |
| L2 | jev tb-v1 | 0.643 | 0.327 |
| L2 | jev tb-v2 | 0.442 | 0.327 |
| L2 | mock | 0.520 | 0.327 |
| L3 | jev tb-v2 | 0.382 | 0.202 |
| L3 | mock | 0.345 | 0.202 |
| L3 | random | 0.835 | 0.202 |

What the live sessions showed:

- **Wording moves Jev a lot.** Dropping two strategy hints (small coins mean-revert; sharp moves on thin books
  are manufactured) cut mean P(down_first) from 0.40 to 0.25 and nearly halved the Brier on identical states.
- **Reachability is ignored.** Binned by realized 5-minute vol over the barrier, real hit rates ran from 2% to
  69% while Jev's P(hit) moved only from 0.37 to 0.56. Both inputs were in the state.
- **A bearish lean in every hour and every symbol**: P(down_first) 0.21 to 0.42 against 0.5% to 13% realized.
- **No sign skill at any horizon.** Against the sign of the forward move at 10 s, 30 s, 60 s and 5 min, Jev's
  lean was right 48% of the time on 8,242 states; a 60-second move averaged 8 bps against a 17 to 30 bps round
  trip.
- The market was a quiet weekend: 89% of fixed-barrier outcomes were "neither" and no selling regime occurred.

### 4.2 Historical replay, six high-volatility meme days, vol-scaled barrier

TRUMP 2025-01-19 (launch) and 2025-02-03 (crash), 1000PEPE 2024-05-14 (pump) and 2024-08-05 (crash),
DOGE 2024-11-12 (pump), WIF 2024-03-14 (at its high). States anonymized, 20 raw 1m bars included.
Outcomes: 32% up, 32% down, 36% neither. 17,168 labeled Jev answers, zero errors, $2.05.

| model | Brier | base rates | direction on 10,939 hits |
|---|---|---|---|
| jev | 0.731 | 0.665 | 52.8% |
| mock | 0.736 | 0.665 | 52.8% |
| random | 0.835 | 0.665 | 50.1% |

| Jev, pooled | mean probability | realized |
|---|---|---|
| up_first | 0.17 | 0.32 |
| down_first | 0.27 | 0.32 |
| neither | 0.56 | 0.36 |

- **Jev is a momentum follower.** Its lean matched the prior 5-minute move 80% of the time; plain continuation
  ran at 52.4%. Its 52.8% is what momentum earns, and the mock earns the same.
- **The bearish bias is structural.** In 17,168 rows Jev put P(up_first) above 0.5 once. On the TRUMP launch
  day, where up happened 40% of the time, its mean P(up) was 0.14. It put P(down_first) above 0.5 on 596 rows
  where down then happened 40% of the time.
- **Per episode** direction accuracy ran 51.7% (TRUMP launch) to 55.0% (WIF); the crash days were 53.2%.
  No regime stood out.
- **Not tradeable at face value.** A 52.8% call on a symmetric barrier nets about 6% of the barrier distance
  gross, 6 to 11 bps on these days, against a 17 to 30 bps round trip.

## 5. Verdict against the handoff

The handoff's gate was: calibrated on the triple-barrier question, and beating the rule-based mock after
costs. On about 28,000 labeled answers across three live sessions, two wordings, fixed and volatility-scaled
barriers, quiet and extreme regimes, and six anonymized historical days:

- Jev is not calibrated on this question. It never beat base rates on Brier, and the bearish bias survived
  wording changes, regimes and raw bars in the state.
- Jev did not beat the mock. On the balanced replay they are indistinguishable.
- The only directional signal, about 52.8% on barrier hits in high-volatility regimes, is explained by
  5-minute momentum and sits below trading costs.

Per the handoff's own rule, steps 2 to 4 (fill engine, risk gate, live size) were not started.

## 6. Implications for the next requirements

Items the first milestone settled, phrased as requirements:

1. **Questions carry facts only.** Goal, horizon, cost, asset class. No strategy hints: Jev follows them, and
   the hinted wording was the worst performer. Keep wording versioned and never edit a version in place.
2. **Code owns reachability.** Jev does not weigh volatility against the barrier. Barrier size must be set
   in code from realized vol (the vol-scaled mode) so the model is only asked about direction and completion.
3. **Calibration tests need balanced outcomes.** A fixed-percent barrier in a quiet market measures the
   ability to predict quiet. Require roughly a third per outcome before reading a Brier score.
4. **Define the pass criteria before collecting.** Beat base rates (climatology) on Brier, beat the mock, and
   show direction-on-hits above the momentum baseline, each with a minimum row count across at least one
   up, one down and one quiet regime. The handoff said "hundreds of trades across several regimes"; a
   weekend of live data delivered one regime, so the replay should be a required gate before any live run.
5. **Anonymized historical replay is part of the standard pipeline**, not an afterthought, for any model whose
   calibration comes from LLM reference answers.
6. **Budget.** The whole milestone cost $4.30 of Jev credit. Experiments are cheap; the expensive thing is
   wall-clock waiting for live regimes, which the replay removes.
7. **Universe definition** can rely on Binance's `Meme` tag plus a volume band; no hand-kept list.
8. **The regime question has no ground truth** and was never scored. Either drop it or define how it is
   evaluated.
9. **Two websocket connections** and a trade-print proxy for historical books are facts of the data source
   that the architecture section should state.

Open questions the data does not settle:

- Whether a different input representation (raw bars already tried; raw prints, longer history, or a
  text summary) changes Jev's bias. Nothing tried so far did.
- Whether the bearish lean is specific to this question shape (three-way with "neither") or to Jev in general
  on price-like state. A two-way direction-only question conditional on a vol-scaled barrier is the obvious
  next probe, and it is a small change to the question builder.
- Whether a maker-entry fill model changes the after-cost picture; at 52.8% direction it does not, but a
  model with real skill would need the pessimistic fill engine from step 2 to be judged.

## 7. Caveats

- Live data covered one quiet weekend; the replay covered six extreme days. Nothing in between yet.
- Replayed states lack L2 imbalance and fine depth; live states had them and scored no better.
- Anonymization keeps days-since-listing and 24h volume, which could hint at an episode. Jev's worst day was
  the most famous one, so recall is not driving the results.
- "Direction on hits" conditions on a hit, which a trader cannot know in advance; it is used only to separate
  direction skill from reachability.

## 8. Post-review checks (2026-10-25)

Two checks from the milestone review, run on the existing ledgers with `pnpm signal`, no new Jev calls.
Out-of-sample means two-fold by episode on the six replay days (both directions reported) and a first-half /
second-half time split on the 12-hour live session.

### 8.1 Bias versus signal

Murphy decomposition of Jev's per-outcome Brier on the six replay days (17,168 rows):

| outcome | Brier | reliability (removable) | resolution (not creatable) | uncertainty | AUC vs rest |
|---|---|---|---|---|---|
| up_first | 0.239 | 0.024 | 0.001 | 0.216 | 0.53 |
| down_first | 0.224 | 0.008 | 0.001 | 0.218 | 0.55 |
| neither | 0.267 | 0.041 | 0.005 | 0.231 | 0.59 |

Direction AUC (up versus down on 10,939 hits): 0.534. Nearly all of Jev's excess Brier is reliability, that
is bias; resolution is at the noise floor. Recalibrating Jev's probabilities (multinomial logistic on its
log-probabilities, fit on one fold, scored on the other) brings it to the base-rate line and no further:

| replay, out of sample | fold A→B | fold B→A |
|---|---|---|
| base rates | 0.665 | 0.667 |
| Jev raw | 0.705 | 0.757 |
| Jev recalibrated | 0.656 | 0.671 |

On the 12-hour live session the recalibrated Jev does beat base rates (0.189 vs 0.216), because in a quiet
market its P(neither) tracks activity (AUC 0.73 for neither-vs-hit). That is reachability, which the mock's
features capture better (0.156), not direction.

### 8.2 Incremental value over the mock's features

Multinomial logistic on the mock's input features (returns over the barrier, flow, imbalance, RSI, vol over
barrier, range, OI change, premium, daily change, range position), with and without Jev's log-probabilities:

| out of sample | features only | features + Jev | difference |
|---|---|---|---|
| replay fold A→B | 0.655 | 0.651 | −0.004 |
| replay fold B→A | 0.640 | 0.654 | +0.014 |
| live, time split | 0.156 | 0.155 | −0.001 |

Direction on hits, out of sample: isotonic-recalibrated Jev, features-only and features-plus-Jev all land on
the base-rate Brier (0.250) with AUC 0.53 to 0.56. Adding Jev's direction to the features changes AUC by
−0.002 and +0.005 across the two replay folds.

Conclusion of the checks: the bearish lean is removable but there is nothing underneath it. Jev's probabilities
carry no information about direction beyond the features it was given, and its only out-of-sample edge, on
quiet live data, is a weaker version of the reachability the vol-scaled barrier already handles in code.

### 8.3 Two-way direction probe (`dir-v1`): pre-registered criteria and result

Wording `dir-v1`: "Assume the mid price WILL reach one of two barriers within the next N minutes: +X% or −X%.
Which one will it reach first?" with two criteria only, asked on the same six replay days (vol-scaled barrier,
20 raw bars, anonymized), Jev only, scored on hit rows out of sample in both episode folds. Criteria were
written before the run; all three had to pass. 17,168 states, 10,939 hits, zero errors, $1.88.

| criterion | threshold | fold A→B | fold B→A | result |
|---|---|---|---|---|
| AUC(up vs down) | ≥ 0.58 | 0.533 | 0.527 | fail |
| recalibrated direction Brier below base rate | ≥ 0.010 | 0.001 | 0.001 | fail |
| features + Jev below features-only Brier | ≥ 0.005 | 0.000 | 0.000 | fail |

Raw direction accuracy 52.7% and 51.5%; raw Brier 0.280 and 0.281 against a 0.250 coin flip, so Jev is
overconfident on direction even when reachability is assumed for it. The pooled AUC of 0.531 equals the
three-way lean's 0.534: asking only about direction did not change what Jev knows about direction.

By the pre-registration, this closes the Jev-on-price-state path.

## 9. Reproducing

```bash
pnpm install && cp .env.example .env     # set TYPESAFE_API_KEY
pnpm dev                                  # live collector
pnpm eval --since 2026-10-24T21:02:00Z    # report on a live session
BARRIER_MODE=vol STATE_BARS_1M=20 pnpm replay -- --symbol TRUMPUSDT --from 2025-01-19
pnpm eval --db data/replay-TRUMPUSDT-2025-01-19.sqlite
pnpm signal -- --dbs data/replay-TRUMPUSDT-2025-01-19.sqlite,data/replay-TRUMPUSDT-2025-02-03.sqlite   # bias vs signal
```
