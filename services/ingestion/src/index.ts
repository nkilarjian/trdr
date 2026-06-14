// Ingestion worker. Polls active listings, values them against fair value, and
// emits alerts. Also the write-path for the compounding data assets (§8):
// every observed slab (by cert) and seller behaviour should be persisted here.

import { buildAlert, computeFairValue, scoreSeller, type Alert, type CanonicalCardKey } from "@trdr/core";
import type { Providers } from "./providers.js";

export * from "./providers.js";
export * from "./feed.js";
export * from "./wishlist.js";

export interface WatchedKey {
  key: CanonicalCardKey;
  /** Confidence that the watched card type maps to comps (catalog door ⇒ < 1). */
  resolutionConfidence: number;
}

/** One scan pass over active listings for the watched keys. Pure: deps in, alerts out. */
export async function scanOnce(providers: Providers, watched: WatchedKey[], now = Date.now()): Promise<Alert[]> {
  const alerts: Alert[] = [];

  for (const w of watched) {
    const comps = await providers.market.getSoldComps(w.key, {
      fromIso: new Date(now - 180 * 86_400_000).toISOString(),
      toIso: new Date(now).toISOString(),
    });
    const fairValue = computeFairValue({ comps, now, resolutionConfidence: w.resolutionConfidence });

    // TODO(§8): persist `comps` into the cert-provenance graph (Timescale) here.

    const listings = await providers.market.searchActive({ key: w.key });
    for (const listing of listings) {
      const sellerRisk = scoreSeller(listing.seller, { sampleSize: listing.seller.feedbackScore });
      const alert = buildAlert({
        listing,
        key: w.key,
        fairValue,
        sellerRisk,
        epnCampaignId: process.env.EBAY_EPN_CAMPAIGN_ID,
      });
      if (alert) alerts.push(alert);
    }
  }
  return alerts;
}

// TODO(worker): wire scanOnce into a BullMQ repeatable job (Redis) on a schedule,
// fan out by watched category, and push fired alerts via Expo Push / APNs / FCM.
export function startWorker(_providers: Providers): never {
  throw new Error("startWorker not implemented — Phase 1 (BullMQ schedule + push fan-out)");
}
