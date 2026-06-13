// Synthetic market history with KNOWN ground truth. The true value follows a
// drifting trajectory; sold comps are sampled around it with noise and sale-type
// effects, and alert candidates carry the realized close plus the true value at
// decision time — so the harness can score both band calibration and alert
// precision. Real/accumulated sold data swaps in behind the same shapes later.

import type { ActiveListing, SoldComp } from "../types.js";
import { gaussian, mulberry32 } from "./prng.js";

export interface AlertCandidate {
  decisionMs: number;
  snapshot: ActiveListing; // what we'd see live at decision time
  realizedClose: number; // what the auction actually closed at
  trueValue: number; // ground-truth fair value at decision time
}

export interface SyntheticHistory {
  sales: SoldComp[];
  candidates: AlertCandidate[];
}

export interface SyntheticParams {
  nowMs: number;
  days?: number;
  startValue?: number;
  driftPerDay?: number; // multiplicative, e.g. 0.001 = +0.1%/day
  noisePct?: number; // sd of multiplicative price noise
  salesPerDay?: number;
  nCandidates?: number;
  seed?: number;
}

const DAY = 86_400_000;

export function generateHistory(params: SyntheticParams): SyntheticHistory {
  const {
    nowMs,
    days = 200,
    startValue = 280,
    driftPerDay = 0.0008,
    noisePct = 0.06,
    salesPerDay = 0.4,
    nCandidates = 60,
    seed = 12345,
  } = params;

  const rand = mulberry32(seed);
  const valueAtDay = (d: number) => startValue * Math.pow(1 + driftPerDay, d);

  // ── sold comps across the window ──
  const sales: SoldComp[] = [];
  const totalSales = Math.round(days * salesPerDay);
  for (let i = 0; i < totalSales; i++) {
    const d = Math.floor(rand() * days);
    const soldAt = nowMs - (days - d) * DAY;
    const price = Math.max(1, valueAtDay(d) * (1 + noisePct * gaussian(rand)));
    const saleType = rand() < 0.8 ? "auction-close" : rand() < 0.6 ? "bin-accepted-offer" : "bin-list";
    sales.push({
      itemId: `syn-s${i}`,
      soldPrice: round2(price),
      soldAt: new Date(soldAt).toISOString(),
      saleType,
      qty: 1,
      seller: { id: `seller${i % 30}`, feedbackScore: 200 + (i % 30) * 50, feedbackPct: 99 },
      rawTitle: "synthetic comp",
    });
  }

  // ── alert candidates near the recent end of the window ──
  const candidates: AlertCandidate[] = [];
  for (let i = 0; i < nCandidates; i++) {
    // Spread decisions across the window so comp density (hence confidence)
    // varies: early decisions sit on a thin history, recent ones on a richer one.
    const d = 12 + Math.floor(rand() * (days - 13));
    const decisionMs = nowMs - (days - d) * DAY;
    const trueValue = valueAtDay(d);

    // current bid sits below true value; how far it climbs by close decides
    // whether it stays a bargain or runs up past fair (the false-alarm source).
    const bidFraction = 0.25 + rand() * 0.6; // 0.25–0.85
    const currentPrice = round2(trueValue * bidFraction);
    const bidCount = Math.floor(rand() * 12);
    const hoursLeft = 1 + rand() * 47;

    // realized close = current bid × run-up. Crucially, THIN markets (decisions
    // on a sparse history → lower model confidence) are also more volatile and
    // prone to wild run-ups — so false alarms concentrate at low confidence,
    // which is exactly what the confidence gate is meant to prune.
    const richness = d / days; // ~0 (thin, early) → 1 (rich, recent)
    const wild = 1 + (1 - richness) * 1.6; // thin history ⇒ wilder closes
    const runup = 1 + rand() * 1.4 * wild;
    const realizedClose = round2(currentPrice * runup * (1 + noisePct * gaussian(rand)));

    candidates.push({
      decisionMs,
      trueValue: round2(trueValue),
      realizedClose,
      snapshot: {
        itemId: `syn-c${i}`,
        title: "synthetic auction",
        buyingOption: "AUCTION",
        currentPrice,
        bidCount,
        endTime: new Date(decisionMs + hoursLeft * 3_600_000).toISOString(),
        seller: { id: `seller${i % 30}`, feedbackScore: 200 + (i % 30) * 50, feedbackPct: 99 },
        itemSpecifics: {},
        slabPhotoUrls: [],
      },
    });
  }

  return { sales, candidates };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
