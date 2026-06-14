// Card valuation building blocks. valueCard() does the per-card work; alertsFrom
// and passportFrom derive the client shapes. buildFeed (cert → one card) and
// scanBoard (the user's wishlist → many cards) both reuse these, so the live API
// and the offline snapshot never drift.

import {
  buildAlert,
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

export function alertsFrom(v: CardValuation, opts: { epnCampaignId?: string; nowMs?: number }): Alert[] {
  const out: Alert[] = [];
  for (const listing of v.listings) {
    const sellerRisk = scoreSeller(listing.seller, { sampleSize: listing.seller.feedbackScore, shillRate: 0.05 });
    const a = buildAlert({ listing, key: v.key, fairValue: v.fairValue, sellerRisk, epnCampaignId: opts.epnCampaignId, nowMs: opts.nowMs });
    if (a) out.push(a);
  }
  return out;
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
    alerts: alertsFrom(v, { epnCampaignId: params.epnCampaignId, nowMs }),
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
