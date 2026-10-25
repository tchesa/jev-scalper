import "dotenv/config";
import { z } from "zod";
import { QUESTION_VERSIONS, type QuestionVersion } from "./model/question.js";

const bool = (def: string) =>
  z
    .string()
    .default(def)
    .transform((s) => ["1", "true", "yes", "on"].includes(s.trim().toLowerCase()));

const list = (def: string) =>
  z
    .string()
    .default(def)
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    );

const envSchema = z.object({
  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_MODEL: z.string().default("jev-latest"),
  MODELS: list("mock,random"),

  SYMBOLS: list(""),
  MAX_SYMBOLS: z.coerce.number().int().positive().default(20),
  MIN_QUOTE_VOLUME_24H: z.coerce.number().nonnegative().default(20_000_000),
  UNIVERSE_REFRESH_MS: z.coerce.number().int().positive().default(5 * 60_000),

  DECISION_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
  MAX_CALLS_PER_ROUND: z.coerce.number().int().positive().default(8),
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(4_000),

  BARRIER_PCT: z.coerce.number().positive().default(0.5),
  // fixed: BARRIER_PCT. vol: BARRIER_VOL_MULT x realized vol over the horizon, clamped to [floor, cap].
  BARRIER_MODE: z.enum(["fixed", "vol"]).default("fixed"),
  BARRIER_VOL_MULT: z.coerce.number().positive().default(1),
  BARRIER_FLOOR_PCT: z.coerce.number().positive().default(0.3),
  BARRIER_CAP_PCT: z.coerce.number().positive().default(3),
  STATE_BARS_1M: z.coerce.number().int().min(0).max(120).default(0),
  HORIZON_MIN: z.coerce.number().positive().default(5),
  ASK_REGIME: bool("true"),
  QUESTION_VERSIONS: list("tb-v1,tb-v2"),

  TAKER_FEE_BPS: z.coerce.number().nonnegative().default(5),
  MAKER_FEE_BPS: z.coerce.number().nonnegative().default(2),
  SLIPPAGE_BPS_PER_SIDE: z.coerce.number().nonnegative().default(10),
  BINANCE_API_KEY: z.string().optional(),
  BINANCE_API_SECRET: z.string().optional(),

  // Prefilters (cheap checks before any model call)
  PREFILTER_MAX_SPREAD_BPS: z.coerce.number().positive().default(15),
  PREFILTER_MIN_DEPTH_25BPS_USD: z.coerce.number().nonnegative().default(20_000),
  PREFILTER_MIN_TRADES_1M: z.coerce.number().int().nonnegative().default(20),
  PREFILTER_MIN_RANGE_5M_VS_BARRIER: z.coerce.number().nonnegative().default(0.25),

  // Liquidity tiers by 24h quote volume (USD)
  TIER_LARGE_USD: z.coerce.number().positive().default(500_000_000),
  TIER_MID_USD: z.coerce.number().positive().default(50_000_000),
  TIER_SMALL_USD: z.coerce.number().positive().default(5_000_000),

  DB_PATH: z.string().default("./data/ledger.sqlite"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type ModelName = "jev" | "mock" | "random";

export interface Config {
  typesafe: { apiKey: string | undefined; model: string };
  models: ModelName[];
  universe: {
    symbols: string[];
    maxSymbols: number;
    minQuoteVolume24h: number;
    refreshMs: number;
  };
  loop: { decisionIntervalMs: number; maxCallsPerRound: number; modelTimeoutMs: number };
  question: {
    barrierPct: number;
    barrierMode: "fixed" | "vol";
    barrierVolMult: number;
    barrierFloorPct: number;
    barrierCapPct: number;
    horizonMs: number;
    askRegime: boolean;
    versions: QuestionVersion[];
  };
  state: { bars1m: number };
  costs: {
    takerFeeBps: number;
    makerFeeBps: number;
    slippageBpsPerSide: number;
  };
  binance: { apiKey: string | undefined; apiSecret: string | undefined };
  prefilter: {
    maxSpreadBps: number;
    minDepth25BpsUsd: number;
    minTrades1m: number;
    minRange5mVsBarrier: number;
  };
  tiers: { largeUsd: number; midUsd: number; smallUsd: number };
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env);
  const models = e.MODELS.map((m) => m.toLowerCase());
  for (const m of models) {
    if (!["jev", "mock", "random"].includes(m)) throw new Error(`Unknown model in MODELS: ${m}`);
  }
  if (models.includes("jev") && !e.TYPESAFE_API_KEY) {
    throw new Error("MODELS includes jev but TYPESAFE_API_KEY is not set");
  }
  return {
    typesafe: { apiKey: e.TYPESAFE_API_KEY, model: e.TYPESAFE_MODEL },
    models: models as ModelName[],
    universe: {
      symbols: e.SYMBOLS.map((s) => s.toUpperCase()),
      maxSymbols: e.MAX_SYMBOLS,
      minQuoteVolume24h: e.MIN_QUOTE_VOLUME_24H,
      refreshMs: e.UNIVERSE_REFRESH_MS,
    },
    loop: {
      decisionIntervalMs: e.DECISION_INTERVAL_MS,
      maxCallsPerRound: e.MAX_CALLS_PER_ROUND,
      modelTimeoutMs: e.MODEL_TIMEOUT_MS,
    },
    question: {
      barrierPct: e.BARRIER_PCT,
      barrierMode: e.BARRIER_MODE,
      barrierVolMult: e.BARRIER_VOL_MULT,
      barrierFloorPct: e.BARRIER_FLOOR_PCT,
      barrierCapPct: e.BARRIER_CAP_PCT,
      horizonMs: Math.round(e.HORIZON_MIN * 60_000),
      askRegime: e.ASK_REGIME,
      versions: e.QUESTION_VERSIONS.map((v) => {
        if (!(QUESTION_VERSIONS as readonly string[]).includes(v)) throw new Error(`Unknown question version: ${v}`);
        return v as QuestionVersion;
      }),
    },
    state: { bars1m: e.STATE_BARS_1M },
    costs: {
      takerFeeBps: e.TAKER_FEE_BPS,
      makerFeeBps: e.MAKER_FEE_BPS,
      slippageBpsPerSide: e.SLIPPAGE_BPS_PER_SIDE,
    },
    binance: { apiKey: e.BINANCE_API_KEY, apiSecret: e.BINANCE_API_SECRET },
    prefilter: {
      maxSpreadBps: e.PREFILTER_MAX_SPREAD_BPS,
      minDepth25BpsUsd: e.PREFILTER_MIN_DEPTH_25BPS_USD,
      minTrades1m: e.PREFILTER_MIN_TRADES_1M,
      minRange5mVsBarrier: e.PREFILTER_MIN_RANGE_5M_VS_BARRIER,
    },
    tiers: { largeUsd: e.TIER_LARGE_USD, midUsd: e.TIER_MID_USD, smallUsd: e.TIER_SMALL_USD },
    dbPath: e.DB_PATH,
    logLevel: e.LOG_LEVEL,
  };
}
