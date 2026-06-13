// DefaultIdentityResolver — all four doors funnel here and emit one Resolution.
// Resolving a cert NUMBER → card details needs the GradingProvider (the
// data-access dependency the brief calls out).

import type { CanonicalCardKey, Grader, Resolution } from "@trdr/core";
import type { GradingProvider } from "@trdr/grading";
import { searchCatalog, toKey } from "./catalog.js";
import { parserFor, PARSERS } from "./parsers.js";
import type { CatalogQuery, IdentityResolver, ImageInput, ListingSource } from "./index.js";

/** Confidence priors by how identity was established (machine-read = high). */
const CONF = {
  barcode: 0.95,
  ocr: 0.8,
  manualCert: 0.92,
  listingWithCert: 0.9,
  listingStated: 0.55,
  catalog: 0.6,
} as const;

export interface ResolverDeps {
  grading: GradingProvider;
  /** Optional source for the paste-a-listing door (5b). */
  listingSource?: ListingSource;
}

export class DefaultIdentityResolver implements IdentityResolver {
  constructor(private readonly deps: ResolverDeps) {}

  /** 5a — read barcode/QR first, fall back to OCR; resolve cert via GradingProvider. */
  async fromSlabScan(image: ImageInput): Promise<Resolution> {
    const warnings: string[] = [];

    // Try barcode across the hinted grader first, then all known formats.
    if (image.barcodePayload) {
      const ordered = image.graderHint ? [parserFor(image.graderHint), ...PARSERS] : PARSERS;
      for (const parser of ordered) {
        const hit = parser?.parseBarcode(image.barcodePayload);
        if (hit) return this.resolveCert(parser!.grader, hit.cert, "barcode", CONF.barcode, warnings);
      }
      warnings.push("barcode present but no parser matched; trying OCR");
    }

    // Fall back to OCR of the printed cert (older slabs lack machine-readable codes).
    if (image.ocrText) {
      const grader = image.graderHint ?? "PSA";
      const ocr = parserFor(grader)?.parseOcr(image.ocrText);
      if (ocr?.cert) return this.resolveCert(grader, ocr.cert, "ocr", CONF.ocr, warnings);
      warnings.push("OCR could not extract a cert number");
    }

    return unresolved("slab scan yielded no readable cert", "ocr", warnings);
  }

  /** 5b — extract grader/grade/cert from a listing; lower confidence if cert unreadable. */
  async fromListing(urlOrItemId: string): Promise<Resolution> {
    const warnings: string[] = [];
    if (!this.deps.listingSource) return unresolved("no listing source configured", "listing", warnings);

    const listing = await this.deps.listingSource.getListing(urlOrItemId);
    if (!listing) return unresolved("listing not found", "listing", warnings);

    const spec = listing.itemSpecifics;
    const grader = (spec.Grader as Grader) || "PSA";
    const cert = spec.Cert || listing.title.match(/\bcert[#:\s]*(\d{8,10})\b/i)?.[1];

    if (cert) {
      const r = await this.resolveCert(grader, cert, "listing", CONF.listingWithCert, warnings);
      if (r.key) return r;
      warnings.push("cert in listing did not resolve; falling back to stated card");
    }

    // Stated-only fallback: build a key from item specifics, drop confidence.
    const grade = Number(spec.Grade);
    const set = spec.Set;
    const number = spec.Number ?? listing.title.match(/#(\w+)/)?.[1];
    if (set && number && Number.isFinite(grade)) {
      const key: CanonicalCardKey = { set, number, grader, grade };
      warnings.push("resolved from stated card + grade only (no machine-read cert)");
      return { key, confidence: CONF.listingStated, source: "listing", warnings };
    }
    return unresolved("listing lacked enough specifics to resolve", "listing", warnings);
  }

  /** 5c — typed/pasted cert. Same resolver. */
  async fromCert(grader: Grader, cert: string): Promise<Resolution> {
    return this.resolveCert(grader, cert, "manual-cert", CONF.manualCert, []);
  }

  /** 5d — card TYPE for watchlists/alerts (not slab identification). */
  async fromCatalog(query: CatalogQuery): Promise<Resolution> {
    const warnings: string[] = [];
    let entry =
      query.text != null
        ? searchCatalog(query.text)[0]
        : query.set && query.number
          ? { set: query.set, number: query.number, variant: query.variant, name: "" }
          : undefined;

    if (!entry) return unresolved("no catalog match", "catalog", warnings);
    const key = toKey(entry, query.grader, query.grade);
    return { key, confidence: CONF.catalog, source: "catalog", warnings };
  }

  /** Shared cert → key path via the GradingProvider. */
  private async resolveCert(
    grader: Grader,
    cert: string,
    source: Resolution["source"],
    baseConfidence: number,
    warnings: string[],
  ): Promise<Resolution> {
    const rec = await this.deps.grading.lookupCert(grader, cert);
    if (!rec) {
      warnings.push(`cert ${cert} not found via ${grader}`);
      return unresolved(`cert ${cert} did not resolve`, source, warnings);
    }
    const key: CanonicalCardKey = {
      set: rec.set,
      number: rec.number,
      variant: rec.variant,
      grader: rec.grader,
      grade: rec.grade,
      qualifier: rec.qualifier,
    };
    // Fold the grader's own confidence into the door's prior.
    return { key, cert, confidence: baseConfidence * rec.confidence, source, warnings };
  }
}

function unresolved(reason: string, source: Resolution["source"], warnings: string[]): Resolution {
  return {
    key: { set: "", number: "", grader: "PSA", grade: 0 },
    confidence: 0,
    source,
    warnings: [...warnings, reason],
  };
}
