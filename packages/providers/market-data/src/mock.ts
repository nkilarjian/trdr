// Mock MarketDataProvider — fixtures with deliberately dirty comps so the
// cleaning subsystem (lots, shill, relists, sale-type noise) is exercised.

import type { ActiveListing, CanonicalCardKey, SoldComp } from "@trdr/core";
import type { ActiveQuery, DateWindow, MarketDataProvider } from "./index.js";

// Sold comps for 2018 Prizm #280 Silver PSA 10. Clean auction closes cluster
// around ~$300; the fixtures also include junk the estimator must reject.
const SOLD_COMPS: SoldComp[] = [
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

const ACTIVE: ActiveListing[] = [
  {
    itemId: "v-underpriced-auction",
    title: "2018 Prizm Luka Doncic #280 Silver PSA 10 GEM MINT",
    buyingOption: "AUCTION",
    currentPrice: 110,
    bidCount: 3,
    endTime: "2026-06-13T20:00:00Z",
    seller: seller("good7", 1500, 99.7),
    itemSpecifics: { Grade: "10", Grader: "PSA", Set: "2018 Panini Prizm" },
    slabPhotoUrls: ["https://img.test/v1.jpg"],
  },
  {
    itemId: "v-fair-bin",
    title: "2018 Prizm Luka #280 Silver PSA 10",
    buyingOption: "BIN",
    currentPrice: 305,
    seller: seller("good3", 2100, 99.6),
    itemSpecifics: { Grade: "10", Grader: "PSA" },
    slabPhotoUrls: ["https://img.test/v2.jpg"],
  },
  {
    itemId: "v-underpriced-bin",
    title: "2018 Prizm Luka Doncic #280 Silver PSA 10 — quick sale",
    buyingOption: "BIN",
    currentPrice: 215,
    seller: seller("liquidator9", 95, 99.0),
    itemSpecifics: { Grade: "10", Grader: "PSA" },
    slabPhotoUrls: ["https://img.test/v3.jpg"],
  },
];

export class MockMarketDataProvider implements MarketDataProvider {
  async searchActive(q: ActiveQuery): Promise<ActiveListing[]> {
    let out = ACTIVE;
    if (q.buyingOptions?.length) out = out.filter((l) => q.buyingOptions!.includes(l.buyingOption));
    return q.limit ? out.slice(0, q.limit) : out;
  }

  async getListing(itemId: string): Promise<ActiveListing | null> {
    return ACTIVE.find((l) => l.itemId === itemId) ?? null;
  }

  async getSoldComps(_key: CanonicalCardKey, window: DateWindow): Promise<SoldComp[]> {
    const from = Date.parse(window.fromIso);
    const to = Date.parse(window.toIso);
    return SOLD_COMPS.filter((s) => {
      const t = Date.parse(s.soldAt);
      return t >= from && t <= to;
    });
  }
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
): SoldComp {
  return {
    itemId,
    soldPrice,
    soldAt: `${date}T12:00:00Z`,
    saleType,
    qty,
    seller: s,
    cert,
    rawTitle: "2018 Prizm #280 Silver PSA 10",
  };
}
