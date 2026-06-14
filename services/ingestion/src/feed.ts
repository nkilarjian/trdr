// Single source of truth for the client "feed" (alerts + card passport).
// Both the API (GET /api/v1/feed) and the snapshot generator (pnpm snapshot)
// call this, so the live response and the offline fallback never drift.

import {
  buildAlert,
  computeFairValue,
  looksManipulated,
  scoreSeller,
  type Alert,
  type CanonicalCardKey,
  type FairValue,
  type Grader,
  type SoldComp,
} from "@trdr/core";
import { DefaultIdentityResolver } from "@trdr/identity";
import type { Providers } from "./providers.js";

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
  /** Decision clock; defaults to now. Pinned by callers for deterministic demos. */
  nowMs?: number;
}

export async function buildFeed(providers: Providers, params: FeedParams): Promise<Feed> {
  const nowMs = params.nowMs ?? Date.now();
  const resolver = new DefaultIdentityResolver({
    grading: providers.grading,
    listingSource: { getListing: (id) => providers.market.getListing(id) },
  });

  const resolution = await resolver.fromCert(params.grader, params.cert);
  const window = {
    fromIso: new Date(nowMs - (params.windowDays ?? 180) * 86_400_000).toISOString(),
    toIso: new Date(nowMs).toISOString(),
  };
  const comps = await providers.market.getSoldComps(resolution.key, window);

  const fairValue: FairValue = computeFairValue({
    comps,
    now: nowMs,
    resolutionConfidence: resolution.confidence,
    prior: params.priorPoint ? { point: params.priorPoint, strength: 0.6 } : undefined,
  });

  const pop = await providers.grading.getPopulation(resolution.key);

  const listings = await providers.market.searchActive({ key: resolution.key });
  const alerts: Alert[] = [];
  for (const listing of listings) {
    const sellerRisk = scoreSeller(listing.seller, { sampleSize: listing.seller.feedbackScore, shillRate: 0.05 });
    const alert = buildAlert({ listing, key: resolution.key, fairValue, sellerRisk, epnCampaignId: params.epnCampaignId, nowMs });
    if (alert) alerts.push(alert);
  }
  const imageUrl = listings[0]?.slabPhotoUrls[0];

  const recent = [...comps]
    .filter((c: SoldComp) => c.qty === 1 && !looksManipulated(c))
    .sort((a: SoldComp, b: SoldComp) => Date.parse(b.soldAt) - Date.parse(a.soldAt))
    .slice(0, 6)
    .map((c) => ({ date: c.soldAt.slice(0, 10), price: c.soldPrice, type: c.saleType }));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    alerts,
    passport: { key: resolution.key, cert: resolution.cert ?? null, imageUrl, fairValue, pop, recent },
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
