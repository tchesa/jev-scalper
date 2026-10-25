import { choice, noul } from "@typesafe-ai/sdk";

export const ANN_QUESTION_VERSION = "ann-v1";

/** What Jev sees: the notice text (anonymized by default) plus a few facts about the asset's markets. */
export interface AnnState {
  notice: { category: string | null; title: string; text: string };
  asset: { token: string; hasPerpetual: boolean; hasSpot: boolean; perpListedDaysAgo: number | null };
}

export const EVENT_LABELS = ["futures_listing", "spot_listing", "delisting", "leverage_or_margin_change", "funding_change", "risk_tag", "promotion_or_campaign", "product_or_other", "passing_mention"] as const;
export const IMPACT_LABELS = ["up", "down", "flat"] as const;
export type Impact = (typeof IMPACT_LABELS)[number];

export const H1_PCT = 1;
export const H24_PCT = 3;

export function annQuestions(costBps = 30) {
  const common =
    `The state holds one Binance announcement that mentions the token TOKEN, plus which markets TOKEN trades on. ` +
    `Everyone sees the announcement at the same moment it is published. `;
  return {
    event: choice(
      `${common}What does this announcement do for TOKEN specifically? If TOKEN is only one name in a long list or is mentioned in passing, say so.`,
      {
        futures_listing: "A new perpetual futures contract on TOKEN will launch.",
        spot_listing: "TOKEN gets a new spot listing or trading pair.",
        delisting: "TOKEN's spot pair or perpetual contract will be delisted or settled.",
        leverage_or_margin_change: "Leverage, margin tiers, or position limits on TOKEN's contract change.",
        funding_change: "Funding rate cap, floor, or settlement interval of TOKEN's contract changes.",
        risk_tag: "TOKEN gets or loses a monitoring or seed tag, or a risk warning.",
        promotion_or_campaign: "A trading campaign, airdrop, Launchpool or reward program involving TOKEN.",
        product_or_other: "Another product change involving TOKEN (margin, earn, convert, Alpha, wallet support).",
        passing_mention: "TOKEN is only mentioned in passing; the announcement is not about TOKEN.",
      },
    ),
    h1: choice(
      `${common}Goal: decide whether to trade TOKEN on this announcement. A round trip costs about ${costBps} bps. ` +
        `Relative to TOKEN's price within one minute of publication, where will its price be ONE HOUR later?`,
      {
        up: `More than ${H1_PCT}% higher.`,
        down: `More than ${H1_PCT}% lower.`,
        flat: `Within ${H1_PCT}% of the publication price.`,
      },
    ),
    h24: choice(
      `${common}Relative to TOKEN's price within one minute of publication, where will its price be 24 HOURS later?`,
      {
        up: `More than ${H24_PCT}% higher.`,
        down: `More than ${H24_PCT}% lower.`,
        flat: `Within ${H24_PCT}% of the publication price.`,
      },
    ),
    novelty: noul(`${common}Is this new information about TOKEN (the first announcement of a change), rather than a reminder, follow-up, schedule confirmation or routine notice?`),
  };
}

export function impactLabel(retPct: number | null, thresholdPct: number): Impact | null {
  if (retPct === null) return null;
  if (retPct > thresholdPct) return "up";
  if (retPct < -thresholdPct) return "down";
  return "flat";
}
