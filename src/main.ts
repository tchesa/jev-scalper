import { randomUUID } from "node:crypto";
import { getCommissionRate, getOpenInterest, getTickers24h } from "./binance/rest.js";
import { BinanceStream, streamsFor, type StreamEvent } from "./binance/ws.js";
import { loadConfig, type Config } from "./config.js";
import { Labeler } from "./labeler/labeler.js";
import { Ledger } from "./ledger/db.js";
import { logger, setLogLevel } from "./log.js";
import { SymbolFeed } from "./market/symbolFeed.js";
import { loadUniverse } from "./market/universe.js";
import { createModels } from "./model/index.js";
import { buildQuestion } from "./model/question.js";
import type { Model, ModelOutput, QuestionSpec } from "./model/types.js";
import { prefilter } from "./prefilter.js";
import { buildState } from "./state/builder.js";

const log = logger("main");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class App {
  private readonly runId = randomUUID();
  private readonly ledger: Ledger;
  private readonly labeler: Labeler;
  private readonly models: Model[];
  private readonly question;
  private readonly feeds = new Map<string, SymbolFeed>();
  private readonly publicStream: BinanceStream; // depth
  private readonly marketStream: BinanceStream; // aggTrade, markPrice, kline
  private timers: NodeJS.Timeout[] = [];
  private roundInFlight = false;
  private stopping = false;
  private rounds = 0;
  private calls = 0;
  private errors = 0;

  constructor(private readonly cfg: Config) {
    this.ledger = new Ledger(cfg.dbPath);
    this.labeler = new Labeler((row) => this.ledger.insertLabel(row));
    this.models = createModels(cfg);
    this.question = buildQuestion(cfg);
    this.publicStream = new BinanceStream("public", (ev) => this.onEvent(ev), () => this.onBookReconnected());
    this.marketStream = new BinanceStream("market", (ev) => this.onEvent(ev), () => undefined);
  }

  async start(): Promise<void> {
    await this.loadFees();
    this.ledger.insertRun(this.runId, Date.now(), { ...this.cfg, typesafe: { ...this.cfg.typesafe, apiKey: undefined }, binance: undefined }, this.question);

    // States from a previous process that never got a label cannot be labeled now: we missed the prints.
    const orphans = this.ledger.unlabeledStateIds();
    for (const id of orphans) {
      this.ledger.insertLabel({ stateId: id, outcome: "lost", hitTs: null, hitPx: null, mid10s: null, mid30s: null, mid60s: null, mid300s: null, maxUpPct: null, maxDownPct: null, labeledTs: Date.now() });
    }
    if (orphans.length) log.warn("marked unlabeled states from earlier runs as lost", { count: orphans.length });

    await this.refreshUniverse();
    this.publicStream.connect();
    this.marketStream.connect();

    this.timers.push(setInterval(() => this.tick(), 1000));
    this.timers.push(setInterval(() => void this.pollOpenInterest(), 30_000));
    this.timers.push(setInterval(() => void this.pollTickers(), 60_000));
    this.timers.push(setInterval(() => void this.refreshUniverse(), this.cfg.universe.refreshMs));
    this.timers.push(setInterval(() => void this.round(), this.cfg.loop.decisionIntervalMs));
    this.timers.push(setInterval(() => this.heartbeat(), 60_000));
    void this.pollOpenInterest();
    log.info("started", {
      runId: this.runId,
      models: this.models.map((m) => m.name),
      symbols: [...this.feeds.keys()],
      barrier: this.cfg.question.barrierMode === "fixed" ? `${this.cfg.question.barrierPct}%` : `${this.cfg.question.barrierVolMult}x vol, ${this.cfg.question.barrierFloorPct}-${this.cfg.question.barrierCapPct}%`,
      horizonMin: this.cfg.question.horizonMs / 60_000,
      questionVersions: this.question.variants.map((v) => v.version),
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log.info("stopping");
    for (const t of this.timers) clearInterval(t);
    this.publicStream.close();
    this.marketStream.close();
    this.labeler.flushAsLost(Date.now());
    this.ledger.close();
  }

  private async loadFees(): Promise<void> {
    const { apiKey, apiSecret } = this.cfg.binance;
    if (!apiKey || !apiSecret) {
      log.warn("no Binance API keys: using configured fee defaults", this.cfg.costs);
      return;
    }
    try {
      const rate = await getCommissionRate("DOGEUSDT", apiKey, apiSecret);
      this.cfg.costs.makerFeeBps = rate.makerBps;
      this.cfg.costs.takerFeeBps = rate.takerBps;
      log.info("fees from /commissionRate", rate);
    } catch (err) {
      log.warn("commissionRate failed, using configured defaults", err);
    }
  }

  private async refreshUniverse(): Promise<void> {
    try {
      const u = await loadUniverse(this.cfg);
      const wanted = new Set(u.selected);
      for (const [symbol, feed] of this.feeds) {
        feed.ticker = u.tickers.get(symbol) ?? feed.ticker;
        if (!wanted.has(symbol)) {
          this.unsubscribe(symbol);
          this.feeds.delete(symbol);
          log.info("dropped symbol", { symbol });
        }
      }
      const added: SymbolFeed[] = [];
      for (const symbol of u.selected) {
        if (this.feeds.has(symbol)) continue;
        const meta = u.metas.get(symbol)!;
        const feed = new SymbolFeed(meta);
        feed.ticker = u.tickers.get(symbol) ?? null;
        this.feeds.set(symbol, feed);
        this.publicStream.subscribe(streamsFor(symbol, "public"));
        this.marketStream.subscribe(streamsFor(symbol, "market"));
        added.push(feed);
      }
      if (added.length) log.info("added symbols", { symbols: added.map((f) => f.symbol) });
      // Bootstrap after subscribing so depth events buffer until the snapshot lands.
      for (const feed of added) {
        try {
          await feed.bootstrap();
        } catch (err) {
          log.warn("bootstrap failed, will retry on next refresh", { symbol: feed.symbol, err });
          this.feeds.delete(feed.symbol);
          this.unsubscribe(feed.symbol);
        }
        await sleep(150);
      }
    } catch (err) {
      log.error("universe refresh failed", err);
    }
  }

  private unsubscribe(symbol: string): void {
    this.publicStream.unsubscribe(streamsFor(symbol, "public"));
    this.marketStream.unsubscribe(streamsFor(symbol, "market"));
  }

  /** Depth diffs may have been missed while the public socket was down: every book resyncs. */
  private onBookReconnected(): void {
    for (const feed of this.feeds.values()) feed.book.reset();
    void (async () => {
      for (const feed of this.feeds.values()) {
        await feed.resyncBook();
        await sleep(150);
      }
    })();
  }

  private onEvent(ev: StreamEvent): void {
    const feed = this.feeds.get(ev.s);
    if (!feed) return;
    switch (ev.e) {
      case "depthUpdate":
        feed.onDepth(ev);
        break;
      case "aggTrade":
        feed.onAggTrade(ev);
        this.labeler.onTrade(ev.s, ev.T, Number(ev.p));
        break;
      case "markPriceUpdate":
        feed.onMark(ev);
        break;
      case "kline":
        feed.onKline(ev);
        break;
    }
  }

  private tick(): void {
    const now = Date.now();
    for (const feed of this.feeds.values()) {
      feed.sampleMid(now);
      this.labeler.onTick(feed.symbol, now, feed.book.synced ? feed.book.mid() : null);
    }
  }

  private async pollOpenInterest(): Promise<void> {
    for (const feed of this.feeds.values()) {
      if (this.stopping) return;
      try {
        const { ts, oi } = await getOpenInterest(feed.symbol);
        feed.onOpenInterest(ts, oi);
      } catch (err) {
        log.debug("openInterest failed", { symbol: feed.symbol, err });
      }
      await sleep(100);
    }
  }

  private async pollTickers(): Promise<void> {
    try {
      const tickers = await getTickers24h();
      for (const feed of this.feeds.values()) feed.ticker = tickers.get(feed.symbol) ?? feed.ticker;
    } catch (err) {
      log.debug("ticker poll failed", err);
    }
  }

  private heartbeat(): void {
    const ready = [...this.feeds.values()].filter((f) => f.isReady()).length;
    log.info("heartbeat", {
      symbols: this.feeds.size,
      ready,
      rounds: this.rounds,
      calls: this.calls,
      errors: this.errors,
      pendingLabels: this.labeler.pendingCount,
      wsMessages: this.publicStream.messageCount + this.marketStream.messageCount,
    });
  }

  /** One decision round: prefilter -> rank -> build state -> ask every model -> log -> track label. */
  private async round(): Promise<void> {
    if (this.roundInFlight || this.stopping) return;
    this.roundInFlight = true;
    const now = Date.now();
    const roundId = `${now}-${this.rounds++}`;
    try {
      const rejects: Record<string, number> = {};
      const candidates: Array<{ feed: SymbolFeed; score: number }> = [];
      for (const feed of this.feeds.values()) {
        const r = prefilter(feed, this.cfg, now);
        if (r.pass) candidates.push({ feed, score: r.score });
        else for (const reason of r.reasons) rejects[reason.split("_")[0]!] = (rejects[reason.split("_")[0]!] ?? 0) + 1;
      }
      candidates.sort((a, b) => b.score - a.score);
      const chosen = candidates.slice(0, this.cfg.loop.maxCallsPerRound);

      const jobs = chosen.map(async ({ feed, score }) => {
        const state = buildState(feed, this.cfg, now);
        if (!state) return;
        const stateId = this.ledger.insertState({ runId: this.runId, roundId, ts: now, state, horizonMs: this.cfg.question.horizonMs, prefilterScore: score });
        this.labeler.track(stateId, feed.symbol, now, feed.book.mid()!, state.barrier.upPct, this.cfg.question.horizonMs);
        const question = buildQuestion(this.cfg, state.barrier.upPct);
        await Promise.all(this.models.map((m) => this.ask(m, stateId, state, question)));
      });
      await Promise.all(jobs);

      this.ledger.insertRound({ id: roundId, runId: this.runId, ts: now, considered: this.feeds.size, passed: candidates.length, queried: chosen.length, rejects });
      log.info("round", { id: roundId, considered: this.feeds.size, passed: candidates.length, queried: chosen.map((c) => c.feed.symbol), rejects });
    } catch (err) {
      log.error("round failed", err);
    } finally {
      this.roundInFlight = false;
    }
  }

  private async ask(model: Model, stateId: number, state: Parameters<Model["evaluate"]>[0], question: QuestionSpec): Promise<void> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.loop.modelTimeoutMs);
    let output: ModelOutput | null = null;
    let error: string | null = null;
    try {
      this.calls++;
      output = await model.evaluate(state, question, ac.signal);
    } catch (err) {
      this.errors++;
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log.warn("model call failed", { model: model.name, symbol: state.symbol, error });
    } finally {
      clearTimeout(timer);
    }
    const ts = Date.now();
    if (output) {
      for (const { version, answer } of output.barriers) {
        this.ledger.insertDecision({ stateId, model: model.name, questionVersion: version, ts, output, barrier: answer, error: null });
        log.debug("decision", { model: model.name, version, symbol: state.symbol, choice: answer.choice, p: answer.probabilities, regime: output.regime?.choice, latencyMs: output.latencyMs });
      }
    } else {
      for (const v of question.variants) {
        this.ledger.insertDecision({ stateId, model: model.name, questionVersion: v.version, ts, output: null, barrier: null, error });
      }
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  const app = new App(cfg);
  const shutdown = (signal: string) => {
    log.info("signal", { signal });
    void app.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => log.error("unhandled rejection", err));
  await app.start();
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
