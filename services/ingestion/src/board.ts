// The "board": everything driven by the USER's wishlist instead of a seeded
// demo card. From the wishlist specs we produce the deals (underpriced alerts
// across the resolvable cards), the wishlist tree + "worth checking out" hits,
// and a passport for the first valued card.

import type { Alert, CanonicalCardKey, FairValue, Grader, WishSpec } from "@trdr/core";
import { alertsFrom, passportFrom, valueCard, type PassportView } from "./feed.js";
import { scanWishlist, type WishlistResult } from "./wishlist.js";
import type { Providers } from "./providers.js";

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
  alerts: Alert[];
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
  const wishlist = await scanWishlist(providers, specs, opts);

  const alerts: Alert[] = [];
  const watching: WatchedCard[] = [];
  const seen = new Set<string>();
  const watchedSeen = new Set<string>();
  let passport: PassportView | null = null;

  for (const spec of specs) {
    const key = specToKey(spec);
    if (!key) continue;
    const v = await valueCard(providers, key, { nowMs, windowDays: opts.windowDays });
    if (!passport && v.fairValue.compCount > 0) passport = passportFrom(v, null);

    // Track every valued watched card so the client can show it even with no deal.
    const sig = `${key.set}|${key.number}|${key.variant ?? ""}|${key.grader}|${key.grade}`;
    if (v.fairValue.compCount > 0 && !watchedSeen.has(sig)) {
      watchedSeen.add(sig);
      const asks = v.listings.map((l) => l.currentPrice).filter((p) => p > 0);
      watching.push({ key, fairValue: v.fairValue, imageUrl: v.imageUrl, lowestAsk: asks.length ? Math.min(...asks) : undefined });
    }

    for (const a of alertsFrom(v, { epnCampaignId: opts.epnCampaignId, nowMs })) {
      if (!seen.has(a.itemId)) {
        seen.add(a.itemId);
        alerts.push(a);
      }
    }
  }

  return { generatedAt: new Date(nowMs).toISOString(), alerts, watching, wishlist, passport };
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
