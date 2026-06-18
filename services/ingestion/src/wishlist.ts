// Background wishlist scan. For each wish, search active listings and score each
// for VALUE (the mispricing engine) and COOL (serendipity). Returns the
// auto-organized wish tree plus the hits "worth checking out".

import {
  buildWishTree,
  computeFairValue,
  ebayDeepLink,
  evaluateSignal,
  scoreInterest,
  type Grader,
  type ActiveListing,
  type CanonicalCardKey,
  type WishNode,
  type WishSpec,
} from "@trdr/core";
import type { Providers } from "./providers.js";

export interface WishHit {
  wishId: string;
  itemId: string;
  title: string;
  currentPrice: number;
  buyingOption: "AUCTION" | "BIN";
  endTime?: string;
  value: number;
  cool: number;
  interest: number;
  tags: string[];
  fairBand?: { lower: number; point: number; upper: number };
  imageUrl?: string;
  deepLink: string;
}

export interface WishlistResult {
  tree: WishNode;
  hits: WishHit[];
}

export interface WishScanOptions {
  nowMs?: number;
  windowDays?: number;
  epnCampaignId?: string;
}

export async function scanWishlist(
  providers: Providers,
  specs: WishSpec[],
  opts: WishScanOptions = {},
): Promise<WishlistResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const window = {
    fromIso: new Date(nowMs - (opts.windowDays ?? 180) * 86_400_000).toISOString(),
    toIso: new Date(nowMs).toISOString(),
  };

  const byItem = new Map<string, WishHit>();

  for (const spec of specs) {
    const listings = await providers.market.searchActive({
      keywords: spec.subject,
      key: { set: spec.set, number: spec.number, variant: spec.variant, grader: spec.grader as Grader, grade: spec.minGrade } as Partial<CanonicalCardKey>,
    });

    // The wish already tells us the exact card; value listings against THAT
    // (eBay listings rarely fill in structured itemSpecifics, so keyFromListing
    // almost always failed → no value → nothing was ever "worth a look").
    const wishKey = specKey(spec);

    for (const listing of listings) {
      // Drop obvious search mismatches when we know the number/variant.
      if (wishKey && !titleMatchesSpec(listing.title, spec)) continue;
      const key = wishKey ?? keyFromListing(listing);

      let value: number | undefined;
      let fairPoint: number | undefined;
      let confidence: number | undefined;
      let fairBand: WishHit["fairBand"];
      if (key) {
        const comps = await providers.market.getSoldComps(key, window);
        if (comps.length) {
          const fv = computeFairValue({ comps, now: nowMs });
          const decision = evaluateSignal(listing, fv, undefined, nowMs);
          value = decision.expectedEdge;
          fairPoint = fv.point;
          confidence = fv.confidence;
          fairBand = { lower: fv.lower, point: fv.point, upper: fv.upper };
        }
      }
      const pop = key ? await providers.grading.getPopulation(key) : null;

      const hoursLeft = listing.endTime ? Math.max(0, (Date.parse(listing.endTime) - nowMs) / 3_600_000) : undefined;
      const score = scoreInterest({
        currentPrice: listing.currentPrice,
        buyingOption: listing.buyingOption,
        bidCount: listing.bidCount,
        hoursLeft,
        expectedEdge: value,
        fairPoint,
        confidence,
        popAtGrade: pop?.atGrade,
        grade: key?.grade,
        variant: key?.variant ?? listing.itemSpecifics.Variant,
        maxPrice: spec.maxPrice,
      });

      if (!score.worthIt) continue;

      const hit: WishHit = {
        wishId: spec.id,
        itemId: listing.itemId,
        title: listing.title,
        currentPrice: listing.currentPrice,
        buyingOption: listing.buyingOption,
        endTime: listing.endTime,
        value: score.value,
        cool: score.cool,
        interest: score.interest,
        tags: score.tags,
        fairBand,
        imageUrl: listing.slabPhotoUrls[0],
        deepLink: ebayDeepLink(listing.itemId, opts.epnCampaignId, listing.title),
      };
      // a listing can match several wishes — keep the strongest attribution
      const existing = byItem.get(listing.itemId);
      if (!existing || hit.interest > existing.interest) byItem.set(listing.itemId, hit);
    }
  }

  const hits = [...byItem.values()].sort((a, b) => b.interest - a.interest);
  return { tree: buildWishTree(specs), hits };
}

function keyFromListing(l: ActiveListing): CanonicalCardKey | null {
  const s = l.itemSpecifics;
  if (!s.Set || !s.Number || !s.Grader || !s.Grade) return null;
  return { set: s.Set, number: s.Number, variant: s.Variant, grader: s.Grader as Grader, grade: Number(s.Grade) };
}

/** A fully-pinned wish (set+number+grader+grade) becomes a valuation key. */
function specKey(s: WishSpec): CanonicalCardKey | null {
  if (s.set && s.number && s.grader && s.minGrade != null) {
    return { set: s.set, number: s.number, variant: s.variant, grader: s.grader as Grader, grade: s.minGrade };
  }
  return null;
}

/** Cheap guard against eBay search returning a different card than the wish. */
function titleMatchesSpec(title: string, spec: WishSpec): boolean {
  const t = title.toLowerCase();
  if (spec.number) {
    const n = spec.number.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (n && !t.replace(/[^a-z0-9]/g, "").includes(n)) return false;
  }
  if (spec.variant) {
    const words = spec.variant.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (!words.every((w) => t.includes(w))) return false;
  }
  return true;
}

/** The seeded demo wishlist — flat wishes the auto-hierarchy organizes. */
export const DEMO_WISHLIST: WishSpec[] = [
  { id: "w-luka-10", category: "Basketball", subject: "Luka Dončić", set: "2018 Panini Prizm Basketball", number: "280", variant: "Silver", grader: "PSA", minGrade: 10, maxPrice: 250 },
  { id: "w-luka-9", category: "Basketball", subject: "Luka Dončić", set: "2018 Panini Prizm Basketball", number: "280", variant: "Silver", grader: "PSA", minGrade: 9 },
  { id: "w-lebron", category: "Basketball", subject: "LeBron James", set: "2003-04 Topps Chrome Basketball", number: "111", grader: "CGC", minGrade: 9.5, maxPrice: 4000 },
  { id: "w-charizard", category: "Pokémon", subject: "Charizard", maxPrice: 1500 },
];

export const DEMO_WISHLIST_OPTS: WishScanOptions = {
  nowMs: Date.parse("2026-06-13T12:00:00Z"),
  epnCampaignId: "DEMO-EPN",
};
