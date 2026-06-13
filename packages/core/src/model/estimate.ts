// ─── 6b. Robust estimator ───
// No raw means. Recency-weighted robust central estimate, with an
// outlier-resistant trend (Theil–Sen) projected to "now" so we report a
// current level rather than a stale one.

import type { WeightedComp } from "./clean.js";

/** Weighted median — robust central tendency. */
export function weightedMedian(values: { value: number; weight: number }[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, v) => s + v.weight, 0);
  let acc = 0;
  for (const v of sorted) {
    acc += v.weight;
    if (acc >= total / 2) return v.value;
  }
  return sorted[sorted.length - 1]!.value;
}

/** Median absolute deviation — robust dispersion. */
export function mad(values: number[], center: number): number {
  if (values.length === 0) return 0;
  const devs = values.map((v) => Math.abs(v - center)).sort((a, b) => a - b);
  const mid = Math.floor(devs.length / 2);
  return devs.length % 2 ? devs[mid]! : (devs[mid - 1]! + devs[mid]!) / 2;
}

/**
 * Theil–Sen slope: median of pairwise slopes (price vs ageDays).
 * ageDays decreases toward now, so we regress on time = -ageDays.
 */
export function theilSenSlope(points: { t: number; y: number }[]): number {
  if (points.length < 2) return 0;
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dt = points[j]!.t - points[i]!.t;
      if (dt !== 0) slopes.push((points[j]!.y - points[i]!.y) / dt);
    }
  }
  if (slopes.length === 0) return 0;
  slopes.sort((a, b) => a - b);
  const mid = Math.floor(slopes.length / 2);
  return slopes.length % 2 ? slopes[mid]! : (slopes[mid - 1]! + slopes[mid]!) / 2;
}

export interface RobustEstimate {
  point: number; // central estimate projected to now
  dispersion: number; // MAD around the central level
  liquidity: number; // sales/day over the observed window (normalized)
}

/** Recency-weighted robust central estimate, trend-projected to now. */
export function robustEstimate(weighted: WeightedComp[]): RobustEstimate {
  const prices = weighted.map((w) => w.comp.soldPrice);
  const level = weightedMedian(
    weighted.map((w) => ({ value: w.comp.soldPrice, weight: w.weight })),
  );

  // time axis: t = -ageDays (more negative = older), so a positive slope = rising
  const slope = theilSenSlope(weighted.map((w) => ({ t: -w.ageDays, y: w.comp.soldPrice })));
  // project the median to now (ageDays = 0 ⇒ t = 0); median sits at median age
  const medianAge = median(weighted.map((w) => w.ageDays));
  const point = Math.max(0, level + slope * medianAge);

  const dispersion = mad(prices, level);

  const spanDays = Math.max(1, Math.max(...weighted.map((w) => w.ageDays)));
  const liquidity = weighted.length / spanDays;

  return { point, dispersion, liquidity };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
