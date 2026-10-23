# Jev meme-perp scalper — project context

Handoff from a claude.ai research session (2026-10-23). Read this before writing code.

## Goal
Automated scalping of meme coin USDⓈ-M perpetuals on Binance, using TypeSafe's **Jev**
(a System One model: structured state in, typed choices with calibrated probabilities out,
~70–500 ms, $0.042 / MTok input) as the signal classifier.

First milestone is NOT live trading. It is a paper-trading simulator on live mainnet data with a
fake balance, charging real Binance fees, to measure whether Jev has any edge after costs.

## Stack
- Node.js / TypeScript, single always-on process on the existing VPS.
- SQLite (or Postgres) append-only event ledger.
- Jev via the TypeSafe SDK (`@typesafe-ai/sdk`, `systemOne`) or the AI SDK (`experimental_evaluate`).
  Docs: https://docs.typesafe.ai/
- `Model` interface so Jev, a rule-based mock, and a random model are swappable by config.

## Architecture
```
Market streams ──> State builder ──> Jev ──> Risk gate ──> Fill engine ──> Ledger ──> Labeler ──> Evaluation
      └──────────── live book & trades also feed the fill engine ────┘
```

1. **Market streams** — per symbol: `@depth@100ms` (synced to a REST snapshot, local L2 book),
   `@aggTrade`, `@markPrice@1s` (mark, funding), 1m klines. Refresh the universe every few minutes
   from `exchangeInfo` + 24h ticker. Use **mainnet** data; Binance testnet books are fake and useless for fills.
2. **State builder** — deterministic code, one compact JSON per symbol. All math lives here, never in Jev.
   Features: mid, spreadBps, book imbalance, depth at 10/25/50 bps, top-5 levels, returns over several
   windows, taker buy/sell/CVD/VWAP + recent trades, 1m SMA20/50, EMA20, RSI14, realized vol, range position,
   funding, premium, OI, OI change, funding change, 24h volume, distance from 24h high, liquidity tier,
   time since listing.
3. **Jev** — only called for symbols that pass cheap prefilters. Main question (triple barrier):
   *"Will price hit +X% before −X% within N minutes?"* → P(up first) / P(down first).
   Optional second question: regime (organic momentum / manipulation / listing event / exhaustion).
   Questions must state goal, horizon and cost context. Do NOT use bare labels like "long or short?".
4. **Risk gate** — plain code with final authority. Trade only if
   `p·TP − (1−p)·SL − fees − expected slippage > 0`. Leverage fixed in config (never chosen by Jev).
   Liquidity floor, spread cap, max open positions, max notional per symbol, daily loss kill switch.
   Skip the round entirely when nothing qualifies. Jev failure/timeout = no trade.
5. **Fill engine** (must be pessimistic):
   - Maker fills: only when price trades *through* the level, or via queue-position tracking
     (size ahead at post time must trade first). A touch is not a fill.
   - Taker/IOC: walk the actual book levels, never fill at mid.
   - Latency: fill against the book at order-arrival time (decision start + Jev latency + network RTT).
   - Fees from `GET /fapi/v1/commissionRate` (don't hardcode). Funding at each contract's own interval
     (many meme perps settle every 1–4 h). Liquidation at simulated leverage on mark price.
   - TP/SL evaluated on real trade prints; stops fill as taker with slippage.
   - Entries post-only maker, exits IOC taker (resting exits cap winners and let losers run).
6. **Ledger** — append-only: decisions, orders, fills, fees, funding, P&L. Store the exact state JSON sent
   to Jev, Jev's answers, probabilities and latency, so any decision can be replayed.
7. **Labeler** — for EVERY Jev call, including ones the risk gate rejected: which barrier hit first, and
   forward mids at 10 s / 30 s / 60 s / 5 min.
8. **Evaluation** — calibration buckets + Brier score; baselines (rule-based mock, random, never-trade)
   through the identical pipeline. Jev must beat the mock after costs, not just zero. Use Probability of
   Backtest Overfitting / Deflated Sharpe when comparing many configs. Hundreds of trades across several
   market regimes before believing any number.

Going live later = replace only the fill engine with a real Binance executor.

## Build order
1. **Streams + state builder + labeler, Jev logging only (no fills).** Measure Jev calibration first; if
   it isn't calibrated on the triple-barrier question, stop before building the rest.  ← START HERE
2. Fill engine + ledger, with baselines running in parallel.
3. Risk gate tuning.
4. Tiny live size; compare live vs simulated P&L.

## Research findings that shape the design
- Most big meme pumps are manufactured: in a 35k-token study, 82.6% of >100% gainers showed wash trading /
  liquidity-pool price inflation (arXiv 2507.01963). Returns: fat tails, positive skew, median ≈ 0.
- Small/illiquid coins show short-term **reversal**; large/liquid coins show **momentum** (Fičura).
  Distance from 1-week high predicts negatively for small coins, positively for large. → Fade vs follow
  must depend on liquidity tier. Buying the +200% top gainer is the setup that tends to mean-revert.
- Exchange listing effects are front-loaded before listing and mean-revert within weeks.
- Copying "smart money" loses most of the edge after frictions (14% → ~3% per trade).
- Tweet/attention volume predicts better than sentiment polarity.
- Costs decide scalping: model taker fee + ≥0.1–0.2% slippage per side, more in fast markets.
- Liquidation cascades and extreme funding are bigger risks on thin meme perps.
- Live LLM trading benchmarks: most agents earn poor returns; edge appears more in liquid markets.
- Jev's "calibration" is measured against frontier-LLM reference answers, not market outcomes.
  Its servers are US West Coast; Binance matching is (as far as known) in Tokyo → too slow for
  sub-second scalps, fine for seconds-to-minutes decisions.

## Prior art reviewed
- `jarrodwatts/jev-trader` — Kuru MON-USDC on Monad. One Jev question per ~300 ms block ("higher or lower
  in ~30 s?"), post-only quote one tick inside the touch. Good feature set and a well-specified question.
  A speed demo, explicitly not trying to be profitable; no backtests.
- `aowang-ai/jev-trade` — fork on Hyperliquid perps (BTC/ETH/SOL/DOGE/BNB). Three Jev questions per second
  (long/short, open/close/hold, leverage up to 50x). Worth copying: maker entries / IOC exits, dry-run
  with a mock model, `Model` interface. Avoid: bare-label prompts, Jev-chosen leverage, no stops or kill
  switch, and `open` adding $40 every tick with no position cap.
- OneBullEx "200% / 20,000 ARRR" article — affiliate marketing, no data. Ignore.

## Implementation status (2026-10-23)
Build-order step 1 is implemented: see README.md for how to run it. `pnpm dev` collects, `pnpm eval` reports.
Decisions for the next step depend on the calibration report, not on code. Things to keep in mind when changing code:
- Any change to the question wording must bump `QUESTION_VERSION` in `src/model/question.ts`.
- Fees come from `/fapi/v1/commissionRate` only when `BINANCE_API_KEY`/`SECRET` are set; otherwise `.env` defaults.
- The labeler only sees prints while the process runs; states orphaned by a restart are labeled `lost`, never guessed.
- Step 2 (fill engine + ledger P&L) should consume `states`/`decisions` rows and the live book; nothing in step 1 fills.
