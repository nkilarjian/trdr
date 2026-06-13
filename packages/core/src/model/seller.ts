// ─── 7b. Seller scoring (Phase-0 seed) ───
// Minimal, probabilistic, internal-facing. Thin history shrinks to the
// category base rate. The full manipulation/pricing/accuracy model lands in
// Phase 2; this is enough to render a risk chip beside every price edge.

import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "@trdr/config";
import type { SellerRef, SellerRiskChip } from "../types.js";

export interface SellerObservation {
  /** Fraction of this seller's auction wins by very-low-feedback accounts. */
  shillRate?: number;
  /** Signed pricing tendency vs market: + = lists above, − = under-market. */
  pricingBias?: number;
  /** Number of observed sales (drives shrinkage). */
  sampleSize?: number;
}

export function scoreSeller(
  seller: SellerRef,
  obs: SellerObservation = {},
  config: ModelConfig = DEFAULT_MODEL_CONFIG,
): SellerRiskChip {
  const n = obs.sampleSize ?? 0;
  const base = config.seller.baseRateManipulationRisk;

  // Empirical-Bayes shrink toward the category base rate on thin history.
  const w = n / (n + config.seller.k0);
  const observed = obs.shillRate ?? base;
  const manipulationRisk = clamp01(w * observed + (1 - w) * base);

  return { label: labelFor(n, manipulationRisk, obs.pricingBias), manipulationRisk, shrunk: w < 0.95 };
}

function labelFor(n: number, risk: number, pricingBias?: number): string {
  if (n < 5) return "limited history";
  if (risk > 0.4) return "elevated manipulation signals";
  if ((pricingBias ?? 0) < -0.05) return "consistent under-market";
  if ((pricingBias ?? 0) > 0.08) return "prices often high";
  return "no notable signals";
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
