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

export interface DetectedSlab {
  id: string;
  grader?: Grader; // read from the label, if legible
  certGuess?: string; // read cert number, if legible
  confidence: number; // [0,1] — how confident the read is
  cropUrl?: string; // cropped image of just this card
  boundingBox?: BoundingBox;
}

export interface VisionProvider {
  /** Detect and read as many slabs as possible from one image. */
  detectSlabs(image: ImageInput): Promise<DetectedSlab[]>;
}

export { MockVisionProvider } from "./mock.js";
export { RealVisionProvider } from "./real.js";
