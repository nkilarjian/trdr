// ─── IdentityResolver ───
// Four input doors, one resolver, one canonical key. Every resolution carries
// a confidence: machine-read cert = high; photo-read or stated-only = lower.
// That confidence flows downstream and caps the valuation's confidence.

import type { Grader, Resolution } from "@trdr/core";

/** Simulated camera input. Real impl carries pixels; mock carries decoded hints. */
export interface ImageInput {
  /** Decoded barcode/QR payload, when the label had a machine-readable code. */
  barcodePayload?: string;
  /** OCR'd text from the printed label, for older slabs lacking codes. */
  ocrText?: string;
  /** Optional hint for which grader's label format to try first. */
  graderHint?: Grader;
}

export interface CatalogQuery {
  set?: string;
  number?: string;
  variant?: string;
  grader: Grader;
  grade: number;
  /** Free-text typeahead, resolved against the catalog. */
  text?: string;
}

/** Minimal listing shape the resolver reads (decoupled from MarketDataProvider). */
export interface ListingLike {
  title: string;
  itemSpecifics: Record<string, string>;
}
export interface ListingSource {
  getListing(urlOrItemId: string): Promise<ListingLike | null>;
}

export interface IdentityResolver {
  fromSlabScan(image: ImageInput): Promise<Resolution>; // 5a
  fromListing(urlOrItemId: string): Promise<Resolution>; // 5b
  fromCert(grader: Grader, cert: string): Promise<Resolution>; // 5c
  fromCatalog(query: CatalogQuery): Promise<Resolution>; // 5d
}

/** Per-grader label parser (PSA/CGC/SGC/BGS formats differ) — a strategy. */
export interface SlabLabelParser {
  grader: Grader;
  parseBarcode(payload: string): { cert: string } | null;
  parseOcr(text: string): { cert?: string; grade?: number } | null;
}

export * from "./parsers.js";
export * from "./catalog.js";
export { DefaultIdentityResolver } from "./resolver.js";
