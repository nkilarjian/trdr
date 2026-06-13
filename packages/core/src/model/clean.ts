// ─── 6a. Comp canonicalization & cleaning (rules before stats) ───
// Comps arrive already mapped to a single CanonicalCardKey (qualifiers
// segregated at resolution time). Here we drop junk, dedupe relists, and
// attach a per-comp weight from sale-type cleanliness, recency, and seller risk.

import type { ModelConfig } from "@trdr/config";
import type { SoldComp } from "../types.js";

export interface WeightedComp {
  comp: SoldComp;
  weight: number;
  ageDays: number;
}

/** Heuristic shill/wash screen: improbable run-up won by a very-low-feedback buyer. */
export function looksManipulated(comp: SoldComp): boolean {
  const fb = comp.seller.feedbackScore ?? 0;
  const lowTrust = fb < 10 || (comp.seller.feedbackPct ?? 100) < 95;
  // auction wins by near-zero-feedback accounts are the classic shill signature
  return comp.saleType === "auction-close" && lowTrust;
}

export interface CleanOptions {
  now: number; // epoch ms ("now" for recency)
  /** Optional per-seller manipulation risk in [0,1] from the seller model (§7b). */
  sellerRisk?: (sellerId: string) => number;
}

/**
 * Apply the cleaning rules and return surviving comps with weights.
 * Order: drop lots → dedupe relists by cert → manipulation screen →
 * weight by (sale-type × recency × seller-trust).
 */
export function cleanComps(
  comps: SoldComp[],
  config: ModelConfig,
  opts: CleanOptions,
): WeightedComp[] {
  const deduped = dedupeByCert(comps);
  const out: WeightedComp[] = [];

  for (const comp of deduped) {
    if (comp.qty > 1) continue; // lots/bundles
    if (looksManipulated(comp)) continue; // shill/wash screen

    const ageDays = Math.max(0, (opts.now - Date.parse(comp.soldAt)) / 86_400_000);
    const recency = Math.exp(-config.estimator.recencyLambda * ageDays);
    const typeWeight = config.saleTypeWeight[comp.saleType];

    let sellerWeight = 1;
    if (opts.sellerRisk) {
      const risk = opts.sellerRisk(comp.seller.id);
      sellerWeight = 1 - risk * (1 - config.seller.highRiskCompWeight);
    }

    const weight = recency * typeWeight * sellerWeight;
    if (weight > 0) out.push({ comp, weight, ageDays });
  }

  return out;
}

/** Keep the most recent observation per physical slab (cert), seeding provenance dedupe. */
function dedupeByCert(comps: SoldComp[]): SoldComp[] {
  const byCert = new Map<string, SoldComp>();
  const noCert: SoldComp[] = [];
  for (const c of comps) {
    if (!c.cert) {
      noCert.push(c);
      continue;
    }
    const existing = byCert.get(c.cert);
    if (!existing || Date.parse(c.soldAt) > Date.parse(existing.soldAt)) {
      byCert.set(c.cert, c);
    }
  }
  return [...byCert.values(), ...noCert];
}
