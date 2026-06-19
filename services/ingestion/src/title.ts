// Resolve a graded-card identity from a messy eBay listing TITLE, so the deal
// engine can hunt the whole market in a category — not just cards the user pinned
// exactly. Best-effort and conservative: returns null unless it can read a grader,
// grade, and a recognizable product. The downstream trust gates (comp matching,
// confidence) still protect against a wrong resolution producing a fake deal.

import type { CanonicalCardKey, Grader } from "@trdr/core";

// Product/brand lines, longest-first so "topps chrome" wins over "topps".
const BRANDS = [
  "panini prizm",
  "topps chrome",
  "bowman chrome",
  "upper deck",
  "stadium club",
  "national treasures",
  "crown royale",
  "donruss optic",
  "prizm",
  "mosaic",
  "optic",
  "select",
  "contenders",
  "obsidian",
  "spectra",
  "immaculate",
  "flawless",
  "certified",
  "phoenix",
  "absolute",
  "chronicles",
  "illusions",
  "revolution",
  "donruss",
  "topps",
  "bowman",
  "fleer",
  "score",
  "hoops",
  "pinnacle",
];

// Parallel/insert words that distinguish a card from its base (kept in the key so
// base ≠ Silver ≠ Genesis in valuation). Team-name colors are intentionally absent.
const PARALLELS = [
  "genesis",
  "reactive",
  "choice",
  "refractor",
  "superfractor",
  "sapphire",
  "atomic",
  "x-fractor",
  "xfractor",
  "fast break",
  "no huddle",
  "cracked ice",
  "shimmer",
  "velocity",
  "hyper",
  "disco",
  "mojo",
  "scope",
  "pulsar",
  "camo",
  "wave",
  "tmall",
  "silver",
  "gold",
  "bronze",
  "platinum",
  "orange",
  "purple",
  "pink",
  "teal",
  "neon",
];

function hasWord(t: string, w: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(t);
}

export interface ResolvedListing {
  key: CanonicalCardKey;
  subject: string; // player/leftover, used as search keywords
}

/** Parse a graded-card key from an eBay title, or null if it isn't confidently a
 *  graded single (need grader + grade + a known product). */
export function keyFromTitle(title: string): ResolvedListing | null {
  const t = title ?? "";
  const lower = t.toLowerCase();

  const gm = t.match(/\b(PSA|CGC|SGC|BGS|BVG|Beckett)\b\s*\.?\s*(10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5)?/i);
  if (!gm) return null;
  const grader = gm[1].toUpperCase() as Grader;
  let grade = gm[2] ? Number(gm[2]) : NaN;
  if (Number.isNaN(grade)) {
    const g2 = lower.match(/\b(10|9\.5|9|8\.5|8)\b/);
    grade = g2 ? Number(g2[1]) : NaN;
  }
  if (Number.isNaN(grade)) return null;

  // The product/set appears EARLY in the title; a parallel like "Genesis Prizm"
  // appears late — so pick the earliest-occurring brand (longest-first breaks ties).
  let brand: string | undefined;
  let brandPos = Infinity;
  for (const b of BRANDS) {
    const i = lower.indexOf(b);
    if (i >= 0 && i < brandPos) {
      brand = b;
      brandPos = i;
    }
  }
  if (!brand) return null; // unknown product — can't value it reliably

  const number = t.match(/#\s*([A-Za-z]{0,4}-?\d+[A-Za-z]?)/)?.[1] ?? "";
  const year = lower.match(/\b(?:19|20)\d{2}(?:[-/]\d{2})?\b/)?.[0] ?? "";
  const variant = PARALLELS.find((p) => hasWord(lower, p));

  const set = [year, brand.replace(/\b\w/g, (c) => c.toUpperCase())].filter(Boolean).join(" ");

  const subject = t
    .replace(/\b(PSA|CGC|SGC|BGS|BVG|Beckett)\b\s*\.?\s*[0-9.]*/gi, " ")
    .replace(/#\s*[A-Za-z]{0,4}-?\d+[A-Za-z]?/g, " ")
    .replace(/\b(?:19|20)\d{2}(?:[-/]\d{2})?\b/g, " ")
    .replace(new RegExp(`\\b(?:${BRANDS.join("|")})\\b`, "gi"), " ")
    .replace(new RegExp(`\\b(?:${PARALLELS.join("|")})\\b`, "gi"), " ")
    .replace(/\b(rookie|rc|mint|gem|card|panini|basketball|football|baseball|soccer|hockey|la liga|epl|ssp|sp|hof|prizms?|auto|signed|psa|cgc)\b/gi, " ")
    .replace(/[^A-Za-z .'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { key: { set: set || brand, number, variant, grader, grade }, subject };
}
