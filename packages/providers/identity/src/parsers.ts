// Per-grader slab-label parsers. Mock formats are deliberately simple; real
// parsers decode each grader's actual barcode/QR payload + label OCR layout.

import type { Grader } from "@trdr/core";
import type { SlabLabelParser } from "./index.js";

// Mock barcode payload convention: "<GRADER>|<CERT>", e.g. "PSA|58127634".
function genericBarcode(grader: Grader): (payload: string) => { cert: string } | null {
  return (payload: string) => {
    const [g, cert] = payload.split("|");
    return g === grader && cert ? { cert } : null;
  };
}

// Mock OCR: pull an 8–10 digit cert and an optional "PSA 10"-style grade.
function genericOcr(): (text: string) => { cert?: string; grade?: number } | null {
  return (text: string) => {
    const cert = text.match(/\b(\d{8,10})\b/)?.[1];
    const grade = text.match(/\b(?:PSA|CGC|SGC|BGS)\s*(\d{1,2}(?:\.5)?)\b/i)?.[1];
    if (!cert && !grade) return null;
    return { cert, grade: grade ? Number(grade) : undefined };
  };
}

export const PARSERS: SlabLabelParser[] = (["PSA", "CGC", "SGC", "BGS"] as Grader[]).map((grader) => ({
  grader,
  parseBarcode: genericBarcode(grader),
  parseOcr: genericOcr(),
}));

export function parserFor(grader: Grader): SlabLabelParser | undefined {
  return PARSERS.find((p) => p.grader === grader);
}
