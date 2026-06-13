// ─── Versioned model tunables ───
// Every knob the quant tunes lives here. The calibration/backtest harness
// (services/model) sweeps these against held-out sold data. Bump `version`
// whenever values change so logged signals can be tied to the config that
// produced them.

export interface ModelConfig {
  version: string;

  estimator: {
    /** Exponential time-decay rate (per day) for recency weighting. */
    recencyLambda: number;
    /** Half-life in days implied by recencyLambda (documentation only). */
    recencyHalfLifeDays: number;
    /** Band half-width = bandK × MAD × widthFactor(compCount, liquidity). */
    bandK: number;
    /** Min clean comps before we trust the data over the structural prior. */
    minCompsForTrust: number;
  };

  shrinkage: {
    /** Empirical-Bayes pseudo-count: weight = n / (n + k0) toward the prior. */
    k0: number;
    /** Default clean-10 / clean-9 price multiplier when set history is absent. */
    defaultTenToNineMultiplier: number;
  };

  saleTypeWeight: Record<"auction-close" | "bin-accepted-offer" | "bin-list", number>;

  signal: {
    /** Round-trip transaction costs as a fraction of price (fees + shipping). */
    transactionCostPct: number;
    /** Required edge margin (fraction of fair value) beyond costs to fire. */
    marginPct: number;
    /** Suppress any signal below this confidence (precision over recall). */
    confidenceGate: number;
  };

  closeForecast: {
    /** Multipliers applied to current bid by remaining-time tier. */
    timeTierMultiplier: { gt24h: number; h6to24: number; h1to6: number; lt1h: number };
    /** Extra lift per additional active bidder (proxy for demand). */
    perBidLift: number;
  };

  seller: {
    /** Pseudo-count for shrinking thin seller history to category base rate. */
    k0: number;
    /** Category base-rate manipulation risk [0,1]. */
    baseRateManipulationRisk: number;
    /** Down-weight applied to comps from high-risk sellers in the estimator. */
    highRiskCompWeight: number;
  };
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  version: "phase0-2026.06.13",
  estimator: {
    recencyLambda: 0.0116, // ~60-day half-life: ln(2)/60
    recencyHalfLifeDays: 60,
    bandK: 1.4826, // MAD → σ-equivalent scaling for a normal core
    minCompsForTrust: 8,
  },
  shrinkage: {
    k0: 6,
    defaultTenToNineMultiplier: 2.4,
  },
  saleTypeWeight: {
    "auction-close": 1.0, // cleanest signal
    "bin-accepted-offer": 0.5, // true price often hidden
    "bin-list": 0.25, // least reliable
  },
  signal: {
    transactionCostPct: 0.15, // eBay + payment + shipping, round-trip-ish
    marginPct: 0.08,
    confidenceGate: 0.7,
  },
  closeForecast: {
    timeTierMultiplier: { gt24h: 2.1, h6to24: 1.55, h1to6: 1.2, lt1h: 1.05 },
    perBidLift: 0.015,
  },
  seller: {
    k0: 10,
    baseRateManipulationRisk: 0.12,
    highRiskCompWeight: 0.3,
  },
};
