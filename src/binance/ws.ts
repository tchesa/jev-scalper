import WebSocket from "ws";
import { logger } from "../log.js";

const log = logger("ws");

/**
 * Since 2026 Binance serves USDⓈ-M market streams under two base paths that cannot be mixed:
 *  - /public/stream : order book streams (depth, bookTicker)
 *  - /market/stream : aggTrade, markPrice, kline, ticker
 */
export type StreamGroup = "public" | "market";
const URL: Record<StreamGroup, string> = {
  public: "wss://fstream.binance.com/public/stream",
  market: "wss://fstream.binance.com/market/stream",
};

export interface DepthEvent {
  e: "depthUpdate";
  E: number;
  T: number;
  s: string;
  U: number;
  u: number;
  pu: number;
  b: Array<[string, string]>;
  a: Array<[string, string]>;
}
export interface AggTradeEvent {
  e: "aggTrade";
  E: number;
  s: string;
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}
export interface MarkPriceEvent {
  e: "markPriceUpdate";
  E: number;
  s: string;
  p: string;
  i: string;
  P: string;
  r: string;
  T: number;
}
export interface KlineEvent {
  e: "kline";
  E: number;
  s: string;
  k: {
    t: number;
    T: number;
    i: string;
    o: string;
    c: string;
    h: string;
    l: string;
    v: string;
    n: number;
    x: boolean;
    q: string;
    V: string;
    Q: string;
  };
}
export type StreamEvent = DepthEvent | AggTradeEvent | MarkPriceEvent | KlineEvent;

export function streamsFor(symbol: string, group: StreamGroup): string[] {
  const s = symbol.toLowerCase();
  return group === "public" ? [`${s}@depth@100ms`] : [`${s}@aggTrade`, `${s}@markPrice@1s`, `${s}@kline_1m`];
}

/**
 * One combined-stream connection with dynamic SUBSCRIBE/UNSUBSCRIBE and reconnect.
 * Binance closes connections after 24h; on any close we reconnect and resubscribe,
 * and emit `reconnected` so books can resync.
 */
export class BinanceStream {
  private ws: WebSocket | null = null;
  private subscribed = new Set<string>();
  private nextId = 1;
  private closed = false;
  private backoffMs = 1000;
  private messages = 0;

  constructor(
    private readonly group: StreamGroup,
    private readonly onEvent: (ev: StreamEvent) => void,
    private readonly onReconnected: () => void,
  ) {}

  get messageCount(): number {
    return this.messages;
  }

  connect(): void {
    if (this.closed) return;
    const streams = [...this.subscribed];
    const base = URL[this.group];
    const url = streams.length ? `${base}?streams=${streams.join("/")}` : base;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => {
      log.info("connected", { group: this.group, streams: streams.length });
      this.backoffMs = 1000;
      this.onReconnected();
    });
    ws.on("message", (raw) => {
      this.messages++;
      let msg: { stream?: string; data?: StreamEvent; result?: unknown; id?: number; error?: unknown };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }
      if (msg.data) this.onEvent(msg.data);
      else if (msg.error) log.warn("stream error", msg.error);
    });
    ws.on("error", (err) => log.warn("socket error", { message: err.message }));
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      log.warn("closed, reconnecting", { group: this.group, code, inMs: this.backoffMs });
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  subscribe(streams: string[]): void {
    const fresh = streams.filter((s) => !this.subscribed.has(s));
    for (const s of fresh) this.subscribed.add(s);
    if (fresh.length && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: "SUBSCRIBE", params: fresh, id: this.nextId++ }));
    }
  }

  unsubscribe(streams: string[]): void {
    const present = streams.filter((s) => this.subscribed.has(s));
    for (const s of present) this.subscribed.delete(s);
    if (present.length && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: "UNSUBSCRIBE", params: present, id: this.nextId++ }));
    }
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}
