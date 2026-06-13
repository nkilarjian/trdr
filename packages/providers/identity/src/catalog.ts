// Mock card catalog for the catalog-search door (5d). A card TYPE, not a slab —
// so resolutions from here are inherently lower-confidence than a read cert.

import type { CanonicalCardKey, Grader } from "@trdr/core";

export interface CatalogEntry {
  set: string;
  number: string;
  variant?: string;
  /** Searchable display name for typeahead. */
  name: string;
}

const CATALOG: CatalogEntry[] = [
  { set: "2018 Panini Prizm Basketball", number: "280", variant: "Silver", name: "Luka Doncic Prizm Silver RC" },
  { set: "2018 Panini Prizm Basketball", number: "280", name: "Luka Doncic Prizm Base RC" },
  { set: "2003-04 Topps Chrome Basketball", number: "111", name: "LeBron James Topps Chrome RC" },
];

export function searchCatalog(text: string): CatalogEntry[] {
  const q = text.toLowerCase();
  return CATALOG.filter(
    (e) => e.name.toLowerCase().includes(q) || e.set.toLowerCase().includes(q) || e.number === text,
  );
}

export function toKey(entry: CatalogEntry, grader: Grader, grade: number): CanonicalCardKey {
  return { set: entry.set, number: entry.number, variant: entry.variant, grader, grade };
}
