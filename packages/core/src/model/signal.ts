// ─── 7a. Close-forecast + signal gate (the false-positive control) ───
// For an auction we forecast the CLOSING price (not compare current bid to
// fair value), then fire "underpriced" only when predicted close beats the
// fair-value lower bound by more than costs + margin AND confidence clears
// the gate. Tuned for precision over recall.

import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "@trdr/config";
import type { ActiveListing, Alert, CanonicalCardKey, FairValue, SellerRiskChip } from "../types.js";

/**
 * Predicted closing price for a live auction; BIN price is actionable as-is.
 * `nowMs` is the decision clock — defaults to Date.now() live, but the backtest
 * harness passes the historical decision time so replays are deterministic.
 */
export function forecastClose(
  listing: ActiveListing,
  config: ModelConfig = DEFAULT_MODEL_CONFIG,
  nowMs: number = Date.now(),
): number {
  if (listing.buyingOption === "BIN") return listing.currentPrice;

  const hoursLeft = listing.endTime
    ? Math.max(0, (Date.parse(listing.endTime) - nowMs) / 3_600_000)
    : 24;
  const tier = config.closeForecast.timeTierMultiplier;
  const base =
    hoursLeft > 24 ? tier.gt24h : hoursLeft > 6 ? tier.h6to24 : hoursLeft > 1 ? tier.h1to6 : tier.lt1h;

  const bidLift = 1 + (listing.bidCount ?? 0) * config.closeForecast.perBidLift;
  return listing.currentPrice * base * bidLift;
}

export interface SignalDecision {
  fire: boolean;
  predictedClose: number;
  expectedEdge: number;
  reason: string;
}

/** The gate. Fire only with real edge after costs AND sufficient confidence. */
export function evaluateSignal(
  listing: ActiveListing,
  fairValue: FairValue,
  config: ModelConfig = DEFAULT_MODEL_CONFIG,
  nowMs: number = Date.now(),
): SignalDecision {
  const predictedClose = forecastClose(listing, config, nowMs);
  const costs = predictedClose * config.signal.transactionCostPct;
  const margin = fairValue.point * config.signal.marginPct;
  const expectedEdge = fairValue.lower - predictedClose - costs - margin;

  if (fairValue.confidence < config.signal.confidenceGate) {
    return { fire: false, predictedClose, expectedEdge, reason: "confidence below gate" };
  }
  if (expectedEdge <= 0) {
    return { fire: false, predictedClose, expectedEdge, reason: "no edge after costs + margin" };
  }
  return { fire: true, predictedClose, expectedEdge, reason: "underpriced" };
}

export interface BuildAlertInput {
  listing: ActiveListing;
  key: CanonicalCardKey;
  fairValue: FairValue;
  sellerRisk: SellerRiskChip;
  epnCampaignId?: string;
  config?: ModelConfig;
  nowMs?: number;
}

/** Build an Alert if the gate fires, else null (suppressed). */
export function buildAlert(input: BuildAlertInput): Alert | null {
  const config = input.config ?? DEFAULT_MODEL_CONFIG;
  const decision = evaluateSignal(input.listing, input.fairValue, config, input.nowMs ?? Date.now());
  if (!decision.fire) return null;

  return {
    itemId: input.listing.itemId,
    key: input.key,
    fairValue: input.fairValue,
    predictedClose: decision.predictedClose,
    expectedEdge: decision.expectedEdge,
    sellerRisk: input.sellerRisk,
    buyingOption: input.listing.buyingOption,
    endTime: input.listing.endTime,
    deepLink: buildDeepLink(input.listing.itemId, input.epnCampaignId),
  };
}

function buildDeepLink(itemId: string, epnCampaignId?: string): string {
  const base = `https://www.ebay.com/itm/${itemId}`;
  if (!epnCampaignId) return base;
  // EPN affiliate wrapper for deep-link monetization (carry itemId through).
  return `https://www.ebay.com/itm/${itemId}?mkcid=1&campid=${epnCampaignId}`;
}
