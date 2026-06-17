// The Library: cards the user owns, plus bulk intake from a single photo.
// Confident slab reads auto-resolve to holdings; uncertain ones go to review.

import { computeFairValue, type CanonicalCardKey, type FairValue, type Grader, type Holding, type SoldComp } from "@trdr/core";
import type { CertRecord } from "@trdr/grading";
import type { DetectedSlab, ImageInput } from "@trdr/vision";
import type { Providers } from "./providers.js";

const DAY = 86_400_000;

// ─── bulk intake (snap your collection) ───

export interface ReviewItem {
  detection: DetectedSlab;
  reason: string;
}
export interface BulkIngestResult {
  detected: number;
  added: Holding[];
  review: ReviewItem[];
}

/** Read many slabs from one image; auto-add confident reads, queue the rest. */
export async function bulkIngest(providers: Providers, image: ImageInput): Promise<BulkIngestResult> {
  const slabs = await providers.vision.detectSlabs(image);
  const added: Holding[] = [];
  const review: ReviewItem[] = [];

  for (const d of slabs) {
    // 1) Prefer the identity read straight off the label — needs no grading API,
    //    so scan works with just a vision backend connected.
    if (d.confidence >= 0.7 && d.grader && d.card?.set && d.card.number != null && d.card.grade != null) {
      added.push({
        id: `h-${d.id}`,
        key: { set: d.card.set, number: String(d.card.number), variant: d.card.variant, grader: d.grader, grade: d.card.grade },
        cert: d.certGuess,
        imageUrl: d.cropUrl,
      });
      continue;
    }
    // 2) Fall back to resolving the cert via the grading provider (when wired).
    if (d.confidence >= 0.8 && d.grader && d.certGuess) {
      const rec = await providers.grading.lookupCert(d.grader, d.certGuess);
      if (rec) {
        added.push({ id: `h-${d.id}`, key: keyFromRec(rec), cert: d.certGuess, imageUrl: d.cropUrl });
        continue;
      }
      review.push({ detection: d, reason: "couldn't match that cert — tap to confirm" });
    } else {
      review.push({ detection: d, reason: d.certGuess || d.card?.set ? "label was hard to read — tap to confirm" : "couldn't read the label — tap to confirm" });
    }
  }
  return { detected: slabs.length, added, review };
}

// ─── library valuation ───

export interface ValuedHolding {
  holding: Holding;
  fairValue?: FairValue;
  trendPct?: number; // ~30-day change, signed
  unrealizedPL?: number; // fair value − cost basis, when known
}

export async function valueLibrary(
  providers: Providers,
  holdings: Holding[],
  nowMs = Date.now(),
): Promise<ValuedHolding[]> {
  const out: ValuedHolding[] = [];
  for (const h of holdings) {
    // Manually-added cards have no photo. Pull a real one from a live listing so
    // the Library looks like a collection, not grey placeholders.
    const [comps, imageUrl] = await Promise.all([
      providers.market.getSoldComps(h.key, {
        fromIso: new Date(nowMs - 180 * DAY).toISOString(),
        toIso: new Date(nowMs).toISOString(),
      }),
      h.imageUrl ? Promise.resolve(h.imageUrl) : firstListingImage(providers, h.key),
    ]);
    const holding = imageUrl && !h.imageUrl ? { ...h, imageUrl } : h;

    if (!comps.length) {
      out.push({ holding });
      continue;
    }

    const fairValue = computeFairValue({ comps, now: nowMs });
    const trendPct = thirtyDayTrend(comps, fairValue.point, nowMs);
    const unrealizedPL = h.acquiredPrice != null ? fairValue.point - h.acquiredPrice : undefined;
    out.push({ holding, fairValue, trendPct, unrealizedPL });
  }
  return out;
}

/** Best-effort representative photo for a card, from a current live listing. */
async function firstListingImage(providers: Providers, key: CanonicalCardKey): Promise<string | undefined> {
  try {
    const listings = await providers.market.searchActive({ key });
    return listings.find((l) => l.slabPhotoUrls?.[0])?.slabPhotoUrls[0];
  } catch {
    return undefined;
  }
}

function thirtyDayTrend(comps: SoldComp[], pointNow: number, nowMs: number): number | undefined {
  const cutoff = nowMs - 30 * DAY;
  const older = comps.filter((c) => Date.parse(c.soldAt) <= cutoff);
  if (older.length < 4) return undefined;
  const prev = computeFairValue({ comps: older, now: cutoff });
  if (prev.point <= 0) return undefined;
  return (pointNow - prev.point) / prev.point;
}

function keyFromRec(rec: CertRecord): CanonicalCardKey {
  return { set: rec.set, number: rec.number, variant: rec.variant, grader: rec.grader as Grader, grade: rec.grade, qualifier: rec.qualifier };
}

// ─── in-memory store (Phase 1; persistence lands with the DB) ───

export class LibraryStore {
  private byId = new Map<string, Holding>();
  constructor(seed: Holding[] = []) {
    for (const h of seed) this.byId.set(h.id, h);
  }
  all(): Holding[] {
    return [...this.byId.values()];
  }
  add(h: Holding): void {
    this.byId.set(h.id, h);
  }
  addMany(hs: Holding[]): void {
    for (const h of hs) this.add(h);
  }
}

/** A few cards the demo user already owns. */
export const DEMO_LIBRARY: Holding[] = [
  { id: "h-own-luka", key: { set: "2018 Panini Prizm Basketball", number: "280", variant: "Silver", grader: "PSA", grade: 10 }, cert: "58127634", acquiredPrice: 180, imageUrl: "https://img.test/own1.jpg" },
  { id: "h-own-lebron", key: { set: "2003-04 Topps Chrome Basketball", number: "111", grader: "CGC", grade: 9.5 }, cert: "4012887001", acquiredPrice: 1200, imageUrl: "https://img.test/own2.jpg" },
  { id: "h-own-charizard", key: { set: "Base Set", number: "4", variant: "1st Edition", grader: "PSA", grade: 9 }, cert: "71045511", acquiredPrice: 350, imageUrl: "https://img.test/own3.jpg" },
];

export const DEMO_LIBRARY_NOW = Date.parse("2026-06-13T12:00:00Z");
