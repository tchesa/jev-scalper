# jev-scalper

Research harness for the question in [CLAUDE.md](CLAUDE.md): does TypeSafe's Jev have any edge, after costs,
as a signal classifier on Binance meme-coin perpetuals?

**Current milestone (build order step 1):** live mainnet streams → deterministic state builder → Jev / mock /
random models answering the triple-barrier question → append-only SQLite ledger → labeler → calibration report.
No fills, no P&L engine, no orders. The output is a calibration verdict.

## Run

```bash
cp .env.example .env   # set TYPESAFE_API_KEY, pick MODELS
pnpm install
pnpm jev:ping          # one Jev call on a synthetic state: checks the key and the question wiring
pnpm dev               # collector: streams, rounds, labels; Ctrl-C to stop
pnpm eval              # calibration report over data/ledger.sqlite
pnpm test && pnpm typecheck
```

Runs as a single Node 22+ process. SQLite is Node's built-in `node:sqlite`, so there is no native build.

## What happens each round (`DECISION_INTERVAL_MS`, default 30 s)

1. Every tracked symbol goes through cheap prefilters (`src/prefilter.ts`): feed ready and fresh, spread cap,
   depth floor at 25 bps, minimum trade count, and enough recent range to make the barrier reachable.
2. Survivors are ranked by an activity score; the top `MAX_CALLS_PER_ROUND` get a state built.
3. `src/state/builder.ts` produces one compact JSON per symbol (book, returns, flow, 1m indicators, funding,
   open interest, 24h stats, liquidity tier, listing age). All math is here; the model only classifies.
4. Every configured model answers the same question on the same state. Jev calls time out at
   `MODEL_TIMEOUT_MS` with no retries. Failures are logged as decisions with an error and count as "no trade".
5. The state, each model's probabilities, confidence, regime and latency are written to the ledger.
6. The labeler watches real trade prints and resolves which barrier was hit first (or `neither` at the
   horizon), plus forward mids at 10 s / 30 s / 60 s / 5 min. Every state is labeled, whether or not any
   model leaned.

Universe: USDT perpetuals Binance tags as `Meme`, ranked by 24h quote volume (46 as of 2026-10-23), refreshed
every 5 min. Override with `SYMBOLS=DOGEUSDT,1000PEPEUSDT`.

## The question (`src/model/question.ts`)

"Starting from the current mid, which barrier will the mid reach first within N minutes: +X% or −X%?" with
the round-trip cost stated in the prompt, and three criteria: `up_first`, `down_first`, `neither`. Two wordings
exist and `QUESTION_VERSIONS` picks which are asked, all in the same request so every state gets every answer:

- `tb-v1` adds two strategy hints (small coins mean-revert, sharp moves on thin books are manufactured). In the
  first 50-minute session it made Jev structurally bearish: P(down_first) averaged 0.45 against 17% realized.
- `tb-v2` states goal, horizon and cost only, and asks for symmetric probabilities in a symmetric market.

Each wording gets its own `decisions` row, so `pnpm eval` reports `jev [tb-v1]` and `jev [tb-v2]` separately on
identical states. The mock and random baselines ignore wording and are recorded under the first version only.
An optional regime question (organic momentum / manipulation / listing event / exhaustion / quiet) rides along.
A new wording must get a new version string; never edit an existing one.

## Reading the report

`pnpm eval` prints, per model and question version: base rates, multi-class Brier score with skill vs climatology, log loss, argmax
accuracy, reliability buckets for P(up_first) and P(down_first), latency percentiles, a per-tier breakdown, and
a *naive* after-cost EV per confidence threshold. The EV is not the fill engine: it assumes barrier hits pay
exactly ±X% and `neither` exits at the 5-minute mid, minus the configured round-trip cost. Use it as a sanity
check only; the decision this milestone exists for is whether Jev's probabilities are calibrated and beat the
rule-based mock. Hundreds of labeled rows across different market regimes before trusting any number.

## Cost

Jev is billed per input token. One state is roughly 1–1.5k tokens. At the defaults (20 symbols, ≤8 calls every
30 s) that is at most ~23k calls/day, about 30M tokens, roughly $1.3/day at $0.042/MTok. The per-round cap and
the interval are the two knobs.

## Ledger schema (`data/ledger.sqlite`)

`runs` (config + question per process start), `rounds` (prefilter counts), `states` (the exact JSON sent),
`decisions` (one per state × model, probabilities, latency, error), `labels` (one per state). Rows are only ever
inserted. States left unlabeled by a crash are marked `lost` on the next start, since the prints were missed.

## Layout

```
src/binance/   REST client, combined websocket stream, local L2 book (snapshot + diff sync)
src/market/    per-symbol feed (book, trades, marks, klines, OI, mid samples), universe selection
src/state/     indicator math and the state builder
src/model/     Model interface, question, Jev / mock / random implementations
src/ledger/    SQLite schema and inserts
src/labeler/   triple-barrier labeling from trade prints
src/eval/      calibration report
src/main.ts    orchestration
```

## Next (per the build order)

Only if Jev is calibrated on this question: pessimistic fill engine (maker fills on trade-through or queue
position, taker walks the book, latency, funding, liquidation), risk gate with the EV inequality, then tiny
live size.
