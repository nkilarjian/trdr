// ─── Canonical domain types shared by every client and service ───
// These are the contracts the whole app is built around. Identity is
// deterministic (from a grading slab), and every valuation is a
// distribution with explicit confidence — never a bare number.

export type Grader = "PSA" | "CGC" | "SGC" | "BGS";

/** Grade qualifiers that MUST segregate populations — a 10(OC) is not a clean 10. */
export type Qualifier = "OC" | "MK" | "ST" | "MC" | "PD" | "OF";

/** The deterministic identity every input door resolves to. */
export interface CanonicalCardKey {
  set: string; // e.g. "2018 Panini Prizm Basketball"
  number: string; // card number within the set
  variant?: string; // parallel / refractor / SP, if any
  grader: Grader;
  grade: number; // 1–10 (BGS allows .5 steps)
  qualifier?: Qualifier; // never mixed into clean populations
}

export type ResolutionSource =
  | "barcode"
  | "ocr"
  | "listing"
  | "manual-cert"
  | "catalog";

/** Output of the IdentityResolver. Confidence flows downstream into valuation. */
export interface Resolution {
  key: CanonicalCardKey;
  cert?: string; // machine-read cert number, when obtained
  confidence: number; // [0,1] — machine-read cert = high; stated-only = low
  source: ResolutionSource;
  warnings: string[];
}

/** Fair value is always a distribution + confidence (Principle: honesty over false precision). */
export interface FairValue {
  point: number;
  lower: number;
  upper: number;
  confidence: number; // [0,1]
  liquidity: number; // sales velocity signal (sales/day, normalized)
  compCount: number; // clean comps that survived cleaning
  dispersion: number; // robust spread (MAD) feeding band width
  shrunk: boolean; // true when empirical-Bayes shrinkage toward prior was applied
}

export interface SellerRef {
  id: string;
  feedbackScore?: number;
  feedbackPct?: number;
}

/** A card the user owns — the Library is a collection of these. */
export interface Holding {
  id: string;
  key: CanonicalCardKey;
  cert?: string;
  imageUrl?: string; // photo of the slab (from a scan or the user)
  acquiredPrice?: number; // cost basis, when known
  acquiredAt?: string; // ISO
}

export type SaleType = "auction-close" | "bin-accepted-offer" | "bin-list";

/** A historical sold comp, pre-cleaning (raw from the market provider). */
export interface SoldComp {
  itemId: string;
  soldPrice: number;
  soldAt: string; // ISO timestamp
  saleType: SaleType;
  qty: number; // >1 ⇒ lot, dropped in cleaning
  seller: SellerRef;
  cert?: string; // seeds the cert-provenance graph
  rawTitle: string;
}

/** A live active listing (auction or BIN) from the market provider. */
export interface ActiveListing {
  itemId: string;
  title: string;
  buyingOption: "AUCTION" | "BIN";
  currentPrice: number;
  bidCount?: number;
  endTime?: string; // ISO; absent for BIN
  seller: SellerRef;
  itemSpecifics: Record<string, string>;
  slabPhotoUrls: string[];
}

/** The actionable mispricing alert surfaced to the client. */
export interface Alert {
  itemId: string;
  key: CanonicalCardKey;
  fairValue: FairValue;
  predictedClose: number; // = currentPrice for BIN
  expectedEdge: number; // fairValue.lower − predictedClose − fees − margin
  sellerRisk: SellerRiskChip;
  buyingOption: "AUCTION" | "BIN";
  endTime?: string;
  imageUrl?: string; // card photo for the alert card
  deepLink: string; // eBay universal/affiliate link carrying itemId
}

/** Internal-facing, probabilistic — never a public accusatory grade. */
export interface SellerRiskChip {
  label: string; // e.g. "limited history", "prices often high", "consistent under-market"
  manipulationRisk: number; // [0,1]
  shrunk: boolean; // shrunk to category base rate on thin history
}
