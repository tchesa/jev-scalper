import type { Config } from "../config.js";
import { JevModel } from "./jev.js";
import { MockModel } from "./mock.js";
import { RandomModel } from "./random.js";
import type { Model } from "./types.js";

export function createModels(cfg: Config, opts: { jevRetries?: number } = {}): Model[] {
  return cfg.models.map((name): Model => {
    switch (name) {
      case "jev":
        return new JevModel(cfg.typesafe.apiKey!, cfg.typesafe.model, cfg.loop.modelTimeoutMs, opts.jevRetries ?? 0);
      case "mock":
        return new MockModel();
      case "random":
        return new RandomModel();
    }
  });
}
