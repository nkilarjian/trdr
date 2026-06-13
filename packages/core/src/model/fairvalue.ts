// ─── 6c/6d. Thin-market shrinkage + distribution output ───
// When comps are plentiful, trust the data. When sparse, shrink toward a
// structural prior (grade ladder / siblings / cross-grader equivalence).
// Output is always { point, lower, upper, confidence } with the band driven
// by comp count, dispersion, liquidity, and trend volatility.

import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "@trdr/config";
import type { FairValue, SoldComp } from "../types.js";
import { cleanComps, type CleanOptions } from "./clean.js";
import { robustEstimate } from "./estimate.js";

export interface StructuralPrior {
  /** Prior central price, e.g. liquid PSA-9 price × set's 10/9 multiplier. */
  point: number;
  /** Confidence in the prior itself [0,1]; scales how hard we lean on it. */
  strength?: number;
}

export interface FairValueInput {
  comps: SoldComp[];
  now: number;
  config?: ModelConfig;
  prior?: StructuralPrior;
  /** Resolution confidence from the IdentityResolver — caps final confidence. */
  resolutionConfidence?: number;
  sellerRisk?: CleanOptions["sellerRisk"];
}

export function computeFairValue(input: FairValueInput): FairValue {
  const config = input.config ?? DEFAULT_MODEL_CONFIG;
  const weighted = cleanComps(input.comps, config, {
    now: input.now,
    sellerRisk: input.sellerRisk,
  });

  const n = weighted.length;

  // Degenerate: no usable comps — fall back entirely to the prior (or zero-confidence).
  if (n === 0) {
    const p = input.prior?.point ?? 0;
    return {
      point: p,
      lower: p * 0.7,
      upper: p * 1.3,
      confidence: input.prior ? 0.25 * (input.prior.strength ?? 1) : 0,
      liquidity: 0,
      compCount: 0,
      dispersion: 0,
      shrunk: Boolean(input.prior),
    };
  }

  const est = robustEstimate(weighted);

  // Empirical-Bayes shrinkage: weight = n / (n + k0) toward the prior.
  let point = est.point;
  let shrunk = false;
  if (input.prior) {
    const w = n / (n + config.shrinkage.k0);
    point = w * est.point + (1 - w) * input.prior.point;
    shrunk = w < 0.95;
  }

  // Band reflects the DISPERSION of individual sales (a coverage interval), not
  // the standard error of the central estimate — so it must NOT shrink with n.
  // Estimate reliability (which does tighten with n & liquidity) lives in
  // `confidence`, not here. half ≈ z · σ, with σ = bandK · MAD.
  const sigma = config.estimator.bandK * est.dispersion;
  const half = Math.max(
    config.estimator.bandZ * sigma,
    point * 0.03, // floor so a band is never absurdly tight on near-zero MAD
  );

  const confidence = computeConfidence(n, est.dispersion, point, est.liquidity, config, input.resolutionConfidence);

  return {
    point,
    lower: Math.max(0, point - half),
    upper: point + half,
    confidence,
    liquidity: est.liquidity,
    compCount: n,
    dispersion: est.dispersion,
    shrunk,
  };
}

function computeConfidence(
  n: number,
  dispersion: number,
  point: number,
  liquidity: number,
  config: ModelConfig,
  resolutionConfidence = 1,
): number {
  const sample = n / (n + config.estimator.minCompsForTrust); // 0→1 with comps
  const cv = point > 0 ? dispersion / point : 1;
  const tightness = 1 / (1 + 4 * cv); // lower coefficient-of-variation ⇒ higher
  const liq = liquidity / (liquidity + 0.1); // some activity ⇒ higher
  const raw = sample * 0.5 + tightness * 0.35 + liq * 0.15;
  return clamp01(raw * resolutionConfidence);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
