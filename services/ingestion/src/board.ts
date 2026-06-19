// The "board": everything driven by the USER's wishlist instead of a seeded
// demo card. From the wishlist specs we produce the deals (underpriced alerts
// across the resolvable cards), the wishlist tree + "worth checking out" hits,
// and a passport for the first valued card.

import { assessListing, computeFairValue, scoreSeller, type ActiveListing, type Alert, type CanonicalCardKey, type FairValue, type Grader, type WishSpec } from "@trdr/core";
import { lowestLegitAsk, passportFrom, valueCard, type PassportView } from "./feed.js";
import { keyFromTitle } from "./title.js";
import { scanWishlist, type WishlistResult } from "./wishlist.js";
import type { Providers } from "./providers.js";

const DAY = 86_400_000;
const HUNT_CARD_CAP = 18; // distinct cards to value per scan (bounds comp lookups + latency)

/**
 * Hunt the broader market in the user's categories: search each wish (player /
 * category / set), RESOLVE every listing it finds into a card from its title,
 * then value those distinct cards and assess each listing. So deals come from the
 * whole market a user cares about — not only the exact cards they pinned. The
 * trust gates (comp matching, confidence, suppression) still decide what's shown.
 */
export async function huntDeals(
  providers: Providers,
  specs: WishSpec[],
  opts: BoardOpts = {},
): Promise<{ deals: Alert[]; speculative: Alert[] }> {
  const nowMs = opts.nowMs ?? Date.now();
  const window = { fromIso: new Date(nowMs - (opts.windowDays ?? 180) * DAY).toISOString(), toIso: new Date(nowMs).toISOString() };

  // BROAD search per wish — player/category (+ grader to skip raw), NO specific
  // card key (that would just re-find the pinned card). keyFromTitle then resolves
  // each listing to whatever card it actually is.
  const queries = new Set(
    specs.map((s) => [s.subject ?? s.category ?? "graded", s.grader].filter(Boolean).join(" ").trim()).filter((q) => q.length > 1),
  );
  const lists = await Promise.all(
    [...queries].map((keywords) => providers.market.searchActive({ keywords, limit: 100 }).catch(() => [] as ActiveListing[])),
  );

  // Resolve each listing to a card and group listings by card.
  const byCard = new Map<string, { key: CanonicalCardKey; listings: ActiveListing[] }>();
  for (const listing of lists.flat()) {
    const r = keyFromTitle(listing.title);
    if (!r) continue;
    const k = r.key;
    const sig = `${k.set}|${k.number}|${k.variant ?? ""}|${k.grader}|${k.grade}`;
    const g = byCard.get(sig) ?? { key: k, listings: [] };
    g.listings.push(listing);
    byCard.set(sig, g);
  }

  // Value the most-listed cards (more listings → more likely a real deal), capped.
  const cards = [...byCard.values()].sort((a, b) => b.listings.length - a.listings.length).slice(0, HUNT_CARD_CAP);
  const results = await Promise.all(
    cards.map(async ({ key, listings }) => {
      const comps = await providers.market.getSoldComps(key, window).catch(() => []);
      if (comps.length < 3) return null; // not enough sales to value confidently
      const fv = computeFairValue({ comps, now: nowMs });
      const d: Alert[] = [];
      const s: Alert[] = [];
      for (const listing of listings) {
        const sellerRisk = scoreSeller(listing.seller, { sampleSize: listing.seller.feedbackScore, shillRate: 0.05 });
        const a = assessListing({ listing, key, fairValue: fv, sellerRisk, epnCampaignId: opts.epnCampaignId, nowMs });
        if (!a) continue;
        if (fv.point > 0 && fv.compCount >= 5 && a.alert.predictedClose < 0.4 * fv.point) continue; // too good to be real → likely a mis-resolve
        (a.tier === "deal" ? d : s).push(a.alert);
      }
      return { d, s };
    }),
  );

  const deals: Alert[] = [];
  const speculative: Alert[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (!r) continue;
    for (const a of r.d) if (!seen.has(a.itemId)) (seen.add(a.itemId), deals.push(a));
    for (const a of r.s) if (!seen.has(a.itemId)) (seen.add(a.itemId), speculative.push(a));
  }
  return { deals, speculative };
}

export interface BoardOpts {
  nowMs?: number;
  windowDays?: number;
  epnCampaignId?: string;
}

/** A card the user watches, with its live value — shown even when it's no deal. */
export interface WatchedCard {
  key: CanonicalCardKey;
  fairValue: FairValue;
  imageUrl?: string;
  lowestAsk?: number;
}

export interface Board {
  generatedAt: string;
  alerts: Alert[]; // confident deals, ranked by net edge after costs
  speculative: Alert[]; // real positive edge but thin/low-confidence — shown separately
  watching: WatchedCard[];
  wishlist: WishlistResult;
  passport: PassportView | null;
}

/** A wish becomes a valuable card key only when it pins set+number+grader+grade. */
export function specToKey(s: WishSpec): CanonicalCardKey | null {
  if (s.set && s.number && s.grader && s.minGrade != null) {
    return { set: s.set, number: s.number, variant: s.variant, grader: s.grader as Grader, grade: s.minGrade };
  }
  return null;
}

export async function scanBoard(providers: Providers, specs: WishSpec[], opts: BoardOpts = {}): Promise<Board> {
  const nowMs = opts.nowMs ?? Date.now();
  // Value every card and scan the wishlist concurrently — network latency is the
  // bulk of the board's time, and doing it card-by-card 502'd the gateway.
  const [wishlist, valued, hunt] = await Promise.all([
    scanWishlist(providers, specs, opts),
    // The user's pinned cards, valued — for the Watching list + passport.
    Promise.all(
      specs.map(async (spec) => {
        const key = specToKey(spec);
        if (!key) return null;
        const v = await valueCard(providers, key, { nowMs, windowDays: opts.windowDays });
        return { key, v };
      }),
    ),
    // Deals come from the BROAD market in the user's categories, not just pins.
    huntDeals(providers, specs, opts),
  ]);

  const watching: WatchedCard[] = [];
  const watchedSeen = new Set<string>();
  let passport: PassportView | null = null;

  for (const r of valued) {
    if (!r) continue;
    const { key, v } = r;
    if (!passport && v.fairValue.compCount > 0) passport = passportFrom(v, null);

    // Track every valued watched card so the client can show it even with no deal.
    const sig = `${key.set}|${key.number}|${key.variant ?? ""}|${key.grader}|${key.grade}`;
    if (v.fairValue.compCount > 0 && !watchedSeen.has(sig)) {
      watchedSeen.add(sig);
      watching.push({ key, fairValue: v.fairValue, imageUrl: v.imageUrl, lowestAsk: lowestLegitAsk(v) });
    }
  }

  // Rank by net realizable edge after costs, descending — the hero number.
  const byEdge = (x: Alert, y: Alert) => y.netEdge - x.netEdge;
  const alerts = [...hunt.deals].sort(byEdge);
  const speculative = [...hunt.speculative].sort(byEdge);

  return { generatedAt: new Date(nowMs).toISOString(), alerts, speculative, watching, wishlist, passport };
}

/** Card keys to accumulate sold data for, derived from the watched wishlist. */
export function watchedKeys(specs: WishSpec[]): CanonicalCardKey[] {
  const out: CanonicalCardKey[] = [];
  const seen = new Set<string>();
  for (const s of specs) {
    const k = specToKey(s);
    if (!k) continue;
    const sig = `${k.set}|${k.number}|${k.variant ?? ""}|${k.grader}|${k.grade}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      out.push(k);
    }
  }
  return out;
}
