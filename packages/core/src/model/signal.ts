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

/** Itemized acquisition + resale costs feeding the NET realizable edge. */
function costsFor(acquire: number, sellAt: number, config: ModelConfig) {
  const fees = sellAt * (config.costs.marketplaceFeePct + config.costs.resaleSpreadPct);
  const shipping = config.costs.shippingFlat;
  const tax = acquire * config.costs.salesTaxPct;
  return { acquire, fees, shipping, tax, total: fees + shipping + tax };
}

/** Human-facing confidence bucket from comp depth + the model's confidence. */
export function confidenceTier(fv: FairValue, config: ModelConfig = DEFAULT_MODEL_CONFIG): "high" | "med" | "low" {
  if (fv.confidence >= 0.7 && fv.compCount >= config.estimator.minCompsForTrust) return "high";
  if (fv.confidence >= config.signal.confidenceGate && fv.compCount >= 4) return "med";
  return "low";
}

/** Can you exit? Maps sales velocity to a plain liquidity tag. */
export function liquidityTag(fv: FairValue): "often" | "occasionally" | "rarely" {
  if (fv.liquidity >= 0.5) return "often";
  if (fv.liquidity >= 0.1) return "occasionally";
  return "rarely";
}

export interface Assessment {
  alert: Alert;
  tier: "deal" | "speculative";
}

/**
 * Assess a live listing into a ranked, classified edge alert, or null when it
 * can't be valued (too few comps) or isn't underpriced after REAL costs.
 * - tier "deal": confident enough to trust (confidence gate + comp depth).
 * - tier "speculative": real positive edge but thin/low-confidence data.
 * Edge is computed off the predicted CLOSE (auctions rise) and the fair-value
 * LOWER bound (so the band's own uncertainty is already priced in).
 */
export function assessListing(input: BuildAlertInput): Assessment | null {
  const config = input.config ?? DEFAULT_MODEL_CONFIG;
  const now = input.nowMs ?? Date.now();
  const { listing, fairValue: fv } = input;

  if (fv.compCount < 3) return null; // not enough sales to value confidently — suppress

  const predictedClose = forecastClose(listing, config, now);
  const c = costsFor(predictedClose, fv.point, config);
  // Displayed edge = net realizable vs MARKET value (point), so under-market finds
  // surface. A confident DEAL additionally has to clear the conservative LOWER
  // bound (so the band's own uncertainty is priced in); the rest is speculative.
  const netEdge = fv.point - predictedClose - c.total;
  if (netEdge <= 0) return null; // not underpriced once costs are paid

  const clearsLowerBand = fv.lower - predictedClose - c.total > 0;
  const tier: "deal" | "speculative" =
    clearsLowerBand && fv.confidence >= config.signal.confidenceGate && fv.compCount >= config.estimator.minCompsForTrust ? "deal" : "speculative";

  const margin = fv.point * config.signal.marginPct;
  const alert: Alert = {
    itemId: listing.itemId,
    key: input.key,
    title: listing.title,
    fairValue: fv,
    predictedClose,
    currentPrice: listing.currentPrice,
    bidCount: listing.bidCount,
    expectedEdge: fv.lower - predictedClose - predictedClose * config.signal.transactionCostPct - margin,
    netEdge,
    netEdgePct: predictedClose > 0 ? netEdge / predictedClose : 0,
    costs: { acquire: predictedClose, fees: c.fees, shipping: c.shipping, tax: c.tax },
    confidenceTier: confidenceTier(fv, config),
    liquidityTag: liquidityTag(fv),
    sellerRisk: input.sellerRisk,
    buyingOption: listing.buyingOption,
    endTime: listing.endTime,
    imageUrl: listing.slabPhotoUrls[0],
    deepLink: ebayDeepLink(listing.itemId, input.epnCampaignId, listing.title),
  };
  return { alert, tier };
}

/** Back-compat: an Alert only when it's a confident DEAL, else null (suppressed). */
export function buildAlert(input: BuildAlertInput): Alert | null {
  const a = assessListing(input);
  return a && a.tier === "deal" ? a.alert : null;
}

/**
 * eBay deep link. Real listings open the item page (carrying the EPN affiliate
 * params). Mock/synthetic item ids (demo data) have no real listing, so they
 * fall back to an eBay SEARCH for the card so the link still goes somewhere real.
 */
export function ebayDeepLink(itemId: string, epnCampaignId?: string, searchQuery?: string): string {
  const isPlaceholder = /^(v-|syn-)/.test(itemId);
  // eBay's /itm/ URL needs the LEGACY numeric id. The Browse API returns a RESTful
  // id like "v1|137281996442|0" — the middle segment is the legacy id; the raw
  // "v1|…|0" form gives a broken/error page.
  const legacyId = itemId.includes("|") ? itemId.split("|")[1] : itemId;
  const url =
    isPlaceholder && searchQuery
      ? `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(searchQuery)}`
      : `https://www.ebay.com/itm/${legacyId}`;
  // Only tag a REAL affiliate campaign; the "DEMO-EPN" placeholder can break the
  // affiliate redirect, so fall through to a clean URL.
  if (!epnCampaignId || epnCampaignId === "DEMO-EPN") return url;
  return `${url}${url.includes("?") ? "&" : "?"}mkcid=1&campid=${epnCampaignId}`;
}
