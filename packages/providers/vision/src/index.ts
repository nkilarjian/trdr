// ─── VisionProvider ───
// Detect MANY graded slabs in a single photo so a user can build their library
// from one picture instead of one card at a time. Each detection carries a
// confidence; the bulk-intake pipeline auto-adds the confident reads and routes
// the rest to a quick "tap to confirm" review.
//
// Real on-device detection (Apple Vision / ML Kit / a server model) is GATED and
// isolated behind this interface — Mock first, like every other provider.

import type { Grader } from "@trdr/core";

export interface ImageInput {
  uri?: string;
  base64?: string; // raw base64 (no data: prefix) — sent to a real backend
  mediaType?: string; // e.g. "image/jpeg" | "image/png"
}

export interface BoundingBox {
  x: number; // all in [0,1], relative to the image
  y: number;
  w: number;
  h: number;
}

// The card identity read straight off the slab label (graded labels print all
// of this). When present, the pipeline can build a holding WITHOUT a grading-API
// cert lookup — so photo-scan works with only a vision backend connected.
export interface DetectedCard {
  set?: string; // descriptive line incl. year/brand/player, e.g. "2018 Panini Prizm Luka Dončić"
  number?: string; // card number within the set
  variant?: string; // parallel / insert / variety, if any
  grade?: number; // numeric grade (BGS allows .5)
}

export interface DetectedSlab {
  id: string;
  grader?: Grader; // read from the label, if legible
  certGuess?: string; // read cert number, if legible
  card?: DetectedCard; // card identity read off the label, if legible
  confidence: number; // [0,1] — how confident the read is
  cropUrl?: string; // cropped image of just this card
  boundingBox?: BoundingBox;
}

/**
 * A card identified off a photo for on-the-spot valuation / trade — GRADED or
 * RAW. `name` is a single search-ready description (year + set + player + number
 * + parallel, plus grader + grade only if it's in a graded slab). Raw cards omit
 * the grade. Deliberately free-text (not CanonicalCardKey) so the trade flow can
 * value graded cards and link raw ones to eBay-sold without the grade-required
 * holding machinery.
 */
export interface IdentifiedCard {
  name: string;
  graded: boolean;
  confidence: number; // [0,1]
  cropUrl?: string;
}

export interface VisionProvider {
  /** Detect and read as many GRADED slabs as possible from one image (label read). */
  detectSlabs(image: ImageInput): Promise<DetectedSlab[]>;
  /** Identify every card in a photo — graded slabs AND raw cards — by reading the
   *  card front, returned as search-ready descriptions for the trade/value flow. */
  identifyCards(image: ImageInput): Promise<IdentifiedCard[]>;
}

export { MockVisionProvider } from "./mock.js";
export { RealVisionProvider } from "./real.js";
export { identifyWithCardSight } from "./cardsight.js";
