import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { tagsMatch } from "../src/market/universe.js";

describe("tagsMatch", () => {
  it("defaults to Meme only", () => {
    const cfg = loadConfig({});
    expect(tagsMatch(["Meme", "Crypto"], cfg)).toBe(true);
    expect(tagsMatch(["Layer-1", "Crypto"], cfg)).toBe(false);
  });

  it("supports include lists, wildcards and exclusions", () => {
    const mid = loadConfig({ UNIVERSE_TAGS: "Layer-1,Layer-2,DeFi,AI,Infrastructure", UNIVERSE_EXCLUDE_TAGS: "Meme,Index" });
    expect(tagsMatch(["Layer-1", "Crypto"], mid)).toBe(true);
    expect(tagsMatch(["DeFi", "Meme"], mid)).toBe(false);
    expect(tagsMatch(["Gaming"], mid)).toBe(false);
    const any = loadConfig({ UNIVERSE_TAGS: "*", UNIVERSE_EXCLUDE_TAGS: "Meme" });
    expect(tagsMatch(["Gaming"], any)).toBe(true);
    expect(tagsMatch(["Meme"], any)).toBe(false);
  });
});
