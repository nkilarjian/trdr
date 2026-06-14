// Mock MarketDataProvider — fixtures with deliberately dirty comps so the
// cleaning subsystem (lots, shill, relists, sale-type noise) is exercised, plus
// a few diverse cards so the wishlist scan surfaces both "good value" and
// "cool find" hits.

import type { ActiveListing, CanonicalCardKey, SoldComp } from "@trdr/core";
import type { ActiveQuery, DateWindow, MarketDataProvider } from "./index.js";

// Sold comps for 2018 Prizm #280 Silver PSA 10. Clean auction closes cluster
// around ~$300; the fixtures also include junk the estimator must reject.
const LUKA_COMPS: SoldComp[] = [
  c("s1", 305, "2026-06-10", "auction-close", 1, seller("good1", 1200, 99.8)),
  c("s2", 298, "2026-06-07", "auction-close", 1, seller("good2", 540, 100)),
  c("s3", 312, "2026-06-02", "auction-close", 1, seller("good3", 2100, 99.6), "58127634"),
  c("s4", 289, "2026-05-28", "auction-close", 1, seller("good4", 88, 99.1)),
  c("s5", 320, "2026-05-20", "bin-accepted-offer", 1, seller("good5", 760, 99.9)),
  c("s6", 295, "2026-05-12", "auction-close", 1, seller("good2", 540, 100)),
  c("s7", 340, "2026-05-01", "bin-list", 1, seller("good6", 410, 98.9)),
  c("s8", 308, "2026-04-22", "auction-close", 1, seller("good7", 1500, 99.7)),
  c("s9", 312, "2026-04-21", "auction-close", 1, seller("good3", 2100, 99.6), "58127634"), // relist of s3 (same cert)
  c("s10", 301, "2026-06-11", "auction-close", 1, seller("good8", 670, 99.5)),
  c("s11", 296, "2026-06-08", "auction-close", 1, seller("good9", 1320, 99.9)),
  c("s12", 309, "2026-06-04", "auction-close", 1, seller("good10", 240, 99.2)),
  c("s13", 303, "2026-05-30", "auction-close", 1, seller("good11", 880, 99.8)),
  c("s14", 299, "2026-05-24", "auction-close", 1, seller("good12", 510, 99.6)),
  c("s15", 307, "2026-05-16", "auction-close", 1, seller("good13", 1900, 99.7)),
  c("s16", 294, "2026-05-08", "auction-close", 1, seller("good14", 430, 99.4)),
  c("s17", 302, "2026-06-12", "auction-close", 1, seller("good15", 760, 99.8)),
  c("s18", 297, "2026-06-09", "auction-close", 1, seller("good16", 1110, 99.6)),
  c("s19", 311, "2026-06-06", "auction-close", 1, seller("good17", 350, 99.3)),
  c("s20", 300, "2026-06-03", "auction-close", 1, seller("good18", 980, 99.9)),
  c("s21", 305, "2026-05-27", "auction-close", 1, seller("good19", 620, 99.5)),
  c("s22", 296, "2026-05-19", "auction-close", 1, seller("good20", 1450, 99.7)),
  // ── junk the cleaner must drop ──
  c("j1", 90, "2026-06-09", "auction-close", 1, seller("shill1", 2, 80)), // shill: near-zero feedback win
  c("j2", 640, "2026-06-05", "bin-list", 2, seller("good1", 1200, 99.8)), // lot of 2
];

// 2003-04 Topps Chrome LeBron #111 CGC 9.5 — clusters ~$1,100.
const LEBRON_COMPS: SoldComp[] = [
  c("l1", 1120, "2026-06-09", "auction-close", 1, seller("good21", 900, 99.7), undefined, "LeBron #111 CGC 9.5"),
  c("l2", 1080, "2026-06-02", "auction-close", 1, seller("good22", 1400, 99.8), undefined, "LeBron #111 CGC 9.5"),
  c("l3", 1150, "2026-05-24", "auction-close", 1, seller("good23", 600, 99.5), undefined, "LeBron #111 CGC 9.5"),
  c("l4", 1095, "2026-05-15", "bin-accepted-offer", 1, seller("good24", 2200, 99.9), undefined, "LeBron #111 CGC 9.5"),
  c("l5", 1130, "2026-05-04", "auction-close", 1, seller("good25", 770, 99.6), undefined, "LeBron #111 CGC 9.5"),
  c("l6", 1075, "2026-04-26", "auction-close", 1, seller("good26", 510, 99.4), undefined, "LeBron #111 CGC 9.5"),
  c("l7", 1140, "2026-04-12", "auction-close", 1, seller("good27", 1650, 99.8), undefined, "LeBron #111 CGC 9.5"),
  c("l8", 1100, "2026-03-30", "auction-close", 1, seller("good28", 430, 99.2), undefined, "LeBron #111 CGC 9.5"),
];

const ACTIVE: ActiveListing[] = [
  {
    itemId: "v-underpriced-auction",
    title: "2018 Prizm Luka Doncic #280 Silver PSA 10 GEM MINT",
    buyingOption: "AUCTION",
    currentPrice: 110,
    bidCount: 3,
    endTime: "2026-06-13T20:00:00Z",
    seller: seller("good7", 1500, 99.7),
    itemSpecifics: { Grade: "10", Grader: "PSA", Set: "2018 Panini Prizm Basketball", Number: "280", Variant: "Silver" },
    slabPhotoUrls: ["https://img.test/v1.jpg"],
  },
  {
    itemId: "v-fair-bin",
    title: "2018 Prizm Luka #280 Silver PSA 10",
    buyingOption: "BIN",
    currentPrice: 305,
    seller: seller("good3", 2100, 99.6),
    itemSpecifics: { Grade: "10", Grader: "PSA", Set: "2018 Panini Prizm Basketball", Number: "280", Variant: "Silver" },
    slabPhotoUrls: ["https://img.test/v2.jpg"],
  },
  {
    itemId: "v-underpriced-bin",
    title: "2018 Prizm Luka Doncic #280 Silver PSA 10 — quick sale",
    buyingOption: "BIN",
    currentPrice: 215,
    seller: seller("liquidator9", 95, 99.0),
    itemSpecifics: { Grade: "10", Grader: "PSA", Set: "2018 Panini Prizm Basketball", Number: "280", Variant: "Silver" },
    slabPhotoUrls: ["https://img.test/v3.jpg"],
  },
  {
    // good value: BIN well under the ~$1,100 comp level
    itemId: "v-lebron-bin",
    title: "2003-04 Topps Chrome LeBron James #111 RC CGC 9.5",
    buyingOption: "BIN",
    currentPrice: 850,
    seller: seller("good24", 2200, 99.9),
    itemSpecifics: { Grade: "9.5", Grader: "CGC", Set: "2003-04 Topps Chrome Basketball", Number: "111" },
    slabPhotoUrls: ["https://img.test/v4.jpg"],
  },
  {
    // cool find: low-pop 1st-edition, sleeper auction ending soon with 1 bid
    itemId: "v-charizard-auction",
    title: "Pokemon Base Set Charizard #4 1st Edition PSA 9",
    buyingOption: "AUCTION",
    currentPrice: 400,
    bidCount: 1,
    endTime: "2026-06-13T15:00:00Z",
    seller: seller("good29", 640, 99.5),
    itemSpecifics: { Grade: "9", Grader: "PSA", Set: "Base Set", Number: "4", Variant: "1st Edition" },
    slabPhotoUrls: ["https://img.test/v5.jpg"],
  },
];

export class MockMarketDataProvider implements MarketDataProvider {
  async searchActive(q: ActiveQuery): Promise<ActiveListing[]> {
    let out = ACTIVE;
    if (q.buyingOptions?.length) out = out.filter((l) => q.buyingOptions!.includes(l.buyingOption));
    if (q.key?.set) out = out.filter((l) => relate(l.itemSpecifics.Set, q.key!.set!) || relate(l.title, q.key!.set!));
    if (q.key?.number) out = out.filter((l) => l.itemSpecifics.Number === q.key!.number || l.title.includes(`#${q.key!.number}`));
    if (q.key?.grader) out = out.filter((l) => !l.itemSpecifics.Grader || l.itemSpecifics.Grader === q.key!.grader);
    if (q.keywords) out = out.filter((l) => keywordMatch(l.title, q.keywords!));
    return q.limit ? out.slice(0, q.limit) : out;
  }

  async getListing(itemId: string): Promise<ActiveListing | null> {
    return ACTIVE.find((l) => l.itemId === itemId) ?? null;
  }

  async getSoldComps(key: CanonicalCardKey, window: DateWindow): Promise<SoldComp[]> {
    const pool = key.number === "280" ? LUKA_COMPS : key.number === "111" ? LEBRON_COMPS : [];
    const from = Date.parse(window.fromIso);
    const to = Date.parse(window.toIso);
    return pool.filter((s) => {
      const t = Date.parse(s.soldAt);
      return t >= from && t <= to;
    });
  }
}

/** substring-either-way match, tolerant of the set-name variations in titles */
function relate(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.includes(y) || y.includes(x);
}
function keywordMatch(title: string, keywords: string): boolean {
  const t = title.toLowerCase();
  return keywords
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .some((w) => t.includes(w));
}

function seller(id: string, feedbackScore: number, feedbackPct: number) {
  return { id, feedbackScore, feedbackPct };
}

function c(
  itemId: string,
  soldPrice: number,
  date: string,
  saleType: SoldComp["saleType"],
  qty: number,
  s: SoldComp["seller"],
  cert?: string,
  rawTitle = "2018 Prizm #280 Silver PSA 10",
): SoldComp {
  return { itemId, soldPrice, soldAt: `${date}T12:00:00Z`, saleType, qty, seller: s, cert, rawTitle };
}
