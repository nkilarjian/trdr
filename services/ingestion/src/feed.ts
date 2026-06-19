// Card valuation building blocks. valueCard() does the per-card work; alertsFrom
// and passportFrom derive the client shapes. buildFeed (cert → one card) and
// scanBoard (the user's wishlist → many cards) both reuse these, so the live API
// and the offline snapshot never drift.

import {
  assessListing,
  computeFairValue,
  looksManipulated,
  scoreSeller,
  type ActiveListing,
  type Alert,
  type CanonicalCardKey,
  type FairValue,
  type Grader,
  type SoldComp,
} from "@trdr/core";
import { DefaultIdentityResolver } from "@trdr/identity";
import type { Providers } from "./providers.js";

const DAY = 86_400_000;

export interface PassportView {
  key: CanonicalCardKey;
  cert: string | null;
  imageUrl?: string;
  fairValue: FairValue;
  pop: { atGrade: number; higher: number; total: number } | null;
  recent: { date: string; price: number; type: string }[];
}

export interface Feed {
  generatedAt: string;
  alerts: Alert[];
  passport: PassportView;
}

export interface FeedParams {
  grader: Grader;
  cert: string;
  priorPoint?: number;
  windowDays?: number;
  epnCampaignId?: string;
  nowMs?: number;
}

export interface ValueOpts {
  nowMs?: number;
  windowDays?: number;
  priorPoint?: number;
  resolutionConfidence?: number;
}

export interface CardValuation {
  key: CanonicalCardKey;
  fairValue: FairValue;
  listings: ActiveListing[];
  pop: { atGrade: number; higher: number; total: number } | null;
  recent: { date: string; price: number; type: string }[];
  imageUrl?: string;
}

/** Value one card: comps → fair value, its active listings, pop, recent sales. */
export async function valueCard(providers: Providers, key: CanonicalCardKey, opts: ValueOpts = {}): Promise<CardValuation> {
  const nowMs = opts.nowMs ?? Date.now();
  const window = { fromIso: new Date(nowMs - (opts.windowDays ?? 180) * DAY).toISOString(), toIso: new Date(nowMs).toISOString() };
  const comps = await providers.market.getSoldComps(key, window);
  const fairValue = computeFairValue({
    comps,
    now: nowMs,
    resolutionConfidence: opts.resolutionConfidence,
    prior: opts.priorPoint ? { point: opts.priorPoint, strength: 0.6 } : undefined,
  });
  const pop = await providers.grading.getPopulation(key);
  const listings = await providers.market.searchActive({ key });
  const recent = [...comps]
    .filter((c: SoldComp) => c.qty === 1 && !looksManipulated(c))
    .sort((a: SoldComp, b: SoldComp) => Date.parse(b.soldAt) - Date.parse(a.soldAt))
    .slice(0, 6)
    .map((c) => ({ date: c.soldAt.slice(0, 10), price: c.soldPrice, type: c.saleType }));
  return { key, fairValue, listings, pop, recent, imageUrl: listings[0]?.slabPhotoUrls[0] };
}

// A graded slab priced far below a well-supported fair value is almost always a
// MISMATCH (a base card matched to a parallel, a raw card, the wrong number),
// not a real steal — so don't surface it as a deal.
const DEAL_PRICE_FLOOR = 0.4; // drop listings priced under 40% of fair value

export function alertsFrom(v: CardValuation, opts: { epnCampaignId?: string; nowMs?: number }): { deals: Alert[]; speculative: Alert[] } {
  const deals: Alert[] = [];
  const speculative: Alert[] = [];
  const fv = v.fairValue.point;
  for (const listing of v.listings) {
    // The listing title must actually describe this card's parallel (e.g. a
    // "Silver" key shouldn't match a base Prizm listing) — the #1 false positive.
    if (!listingMatchesKey(listing, v.key)) continue;
    const sellerRisk = scoreSeller(listing.seller, { sampleSize: listing.seller.feedbackScore, shillRate: 0.05 });
    const a = assessListing({ listing, key: v.key, fairValue: v.fairValue, sellerRisk, epnCampaignId: opts.epnCampaignId, nowMs: opts.nowMs });
    if (!a) continue;
    if (fv > 0 && v.fairValue.compCount >= 5 && a.alert.predictedClose < DEAL_PRICE_FLOOR * fv) continue; // too good to be real
    (a.tier === "deal" ? deals : speculative).push(a.alert);
  }
  return { deals, speculative };
}

/** Lowest current ask among listings that genuinely match this card — applies
 *  the same match + too-good-to-be-true screen as the deals, so the "watching"
 *  view never shows a mismatched-listing price as the real lowest ask. */
export function lowestLegitAsk(v: CardValuation): number | undefined {
  const fv = v.fairValue.point;
  const trusted = fv > 0 && v.fairValue.compCount >= 5;
  const asks = v.listings
    .filter((l) => listingMatchesKey(l, v.key))
    .map((l) => l.currentPrice)
    .filter((p) => p > 0 && !(trusted && p < DEAL_PRICE_FLOOR * fv));
  return asks.length ? Math.min(...asks) : undefined;
}

/** Cheap guard against eBay search false positives: the listing title must
 *  mention the key's card number and parallel/variant (when present). */
function listingMatchesKey(listing: ActiveListing, key: CanonicalCardKey): boolean {
  const title = (listing.title ?? "").toLowerCase();
  // Card number (e.g. "280") should appear — distinguishes it from other cards
  // of the same player/set. Compare alphanumerics so "#280"/"No. 280" all match.
  const num = (key.number ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (num && !title.replace(/[^a-z0-9]/g, "").includes(num)) return false;
  // Parallel/variant words (e.g. "Silver") — a base card must not match a parallel.
  if (key.variant) {
    const words = key.variant.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (!words.every((w) => title.includes(w))) return false;
  }
  return true;
}

export function passportFrom(v: CardValuation, cert: string | null): PassportView {
  return { key: v.key, cert, imageUrl: v.imageUrl, fairValue: v.fairValue, pop: v.pop, recent: v.recent };
}

export async function buildFeed(providers: Providers, params: FeedParams): Promise<Feed> {
  const nowMs = params.nowMs ?? Date.now();
  const resolver = new DefaultIdentityResolver({
    grading: providers.grading,
    listingSource: { getListing: (id) => providers.market.getListing(id) },
  });
  const resolution = await resolver.fromCert(params.grader, params.cert);
  const v = await valueCard(providers, resolution.key, {
    nowMs,
    windowDays: params.windowDays,
    priorPoint: params.priorPoint,
    resolutionConfidence: resolution.confidence,
  });
  return {
    generatedAt: new Date(nowMs).toISOString(),
    alerts: alertsFrom(v, { epnCampaignId: params.epnCampaignId, nowMs }).deals,
    passport: passportFrom(v, resolution.cert ?? null),
  };
}

/** The Phase-1 demo card (one category, modern PSA graded), pinned for determinism. */
export const DEMO_FEED_PARAMS: FeedParams = {
  grader: "PSA",
  cert: "58127634",
  priorPoint: 300,
  epnCampaignId: "DEMO-EPN",
  nowMs: Date.parse("2026-06-13T12:00:00Z"),
};
