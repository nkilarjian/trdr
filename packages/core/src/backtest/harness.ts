// ─── §9 Calibration / backtest harness ───
// Replays historical sold data walk-forward and measures:
//   • band calibration — do the produced bands actually contain realized sales?
//   • alert precision — of fired signals, what fraction were truly profitable
//     net of fees, using ground-truth value?
//   • the realized-edge distribution.
// Exposes a single tunable confidence gate targeting a precision goal. This loop
// is the product's credibility — a core feature, not a test.

import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "@trdr/config";
import type { SoldComp } from "../types.js";
import { computeFairValue } from "../model/fairvalue.js";
import { evaluateSignal } from "../model/signal.js";
import type { AlertCandidate } from "./synthetic.js";

const DAY = 86_400_000;

export interface CalibrationResult {
  nominalCoverage: number; // the band's intended coverage (documentation)
  empiricalCoverage: number; // fraction of realized sales inside the band
  n: number;
}

/**
 * Walk-forward band calibration. For each sale (after a warmup), value it from
 * comps strictly before its sale time and check whether the realized price falls
 * inside the produced band.
 */
export function runBandCalibration(
  sales: SoldComp[],
  config: ModelConfig = DEFAULT_MODEL_CONFIG,
  windowDays = 120,
  warmup = 8,
): CalibrationResult {
  const ordered = [...sales].sort((a, b) => Date.parse(a.soldAt) - Date.parse(b.soldAt));
  let inside = 0;
  let n = 0;

  for (let i = 0; i < ordered.length; i++) {
    const target = ordered[i]!;
    const t = Date.parse(target.soldAt);
    const priorComps = ordered.filter((c) => {
      const ct = Date.parse(c.soldAt);
      return ct < t && ct >= t - windowDays * DAY;
    });
    if (priorComps.length < warmup) continue;

    const fv = computeFairValue({ comps: priorComps, now: t, config });
    n++;
    if (target.soldPrice >= fv.lower && target.soldPrice <= fv.upper) inside++;
  }

  return { nominalCoverage: config.estimator.bandNominalCoverage, empiricalCoverage: n ? inside / n : 0, n };
}

export interface PrecisionResult {
  gate: number;
  nAlerts: number;
  precision: number; // fraction of fired alerts that were truly profitable
  medianRealizedEdge: number; // median (trueValue − realizedClose − costs) over fired
  recall: number; // fired-and-profitable / all-truly-profitable opportunities
}

/**
 * Alert precision against ground truth. For each candidate we value it from the
 * sold history available at its decision time, run the gate at `gate`, and — if
 * fired — score it profitable iff trueValue − realizedClose − costs > 0.
 */
export function runAlertPrecision(
  sales: SoldComp[],
  candidates: AlertCandidate[],
  gate: number,
  baseConfig: ModelConfig = DEFAULT_MODEL_CONFIG,
  windowDays = 120,
): PrecisionResult {
  const config: ModelConfig = { ...baseConfig, signal: { ...baseConfig.signal, confidenceGate: gate } };
  const ordered = [...sales].sort((a, b) => Date.parse(a.soldAt) - Date.parse(b.soldAt));

  let fired = 0;
  let firedProfitable = 0;
  const firedEdges: number[] = [];
  let allProfitableOpps = 0;

  for (const cand of candidates) {
    const t = cand.decisionMs;
    const costs = cand.realizedClose * config.signal.transactionCostPct;
    const trueEdge = cand.trueValue - cand.realizedClose - costs;
    const isTrulyProfitable = trueEdge > 0;
    if (isTrulyProfitable) allProfitableOpps++;

    const priorComps = ordered.filter((c) => {
      const ct = Date.parse(c.soldAt);
      return ct < t && ct >= t - windowDays * DAY;
    });
    if (priorComps.length < 8) continue;

    const fv = computeFairValue({ comps: priorComps, now: t });
    const decision = evaluateSignal(cand.snapshot, fv, config, t);
    if (!decision.fire) continue;

    fired++;
    firedEdges.push(trueEdge);
    if (isTrulyProfitable) firedProfitable++;
  }

  return {
    gate,
    nAlerts: fired,
    precision: fired ? firedProfitable / fired : 0,
    medianRealizedEdge: median(firedEdges),
    recall: allProfitableOpps ? firedProfitable / allProfitableOpps : 0,
  };
}

export interface GateTuning {
  chosenGate: number;
  achieved: PrecisionResult | null; // null if no gate hits the target
  sweep: PrecisionResult[];
}

/**
 * Sweep the confidence gate and pick the LOWEST gate that still meets the
 * precision target — maximizing recall (catching deals) subject to precision
 * (not crying wolf). Precision over recall when they conflict.
 */
export function tuneGate(
  sales: SoldComp[],
  candidates: AlertCandidate[],
  targetPrecision = 0.85,
  config: ModelConfig = DEFAULT_MODEL_CONFIG,
): GateTuning {
  const sweep: PrecisionResult[] = [];
  for (let g = 0.5; g <= 0.95 + 1e-9; g += 0.05) {
    sweep.push(runAlertPrecision(sales, candidates, round2(g), config));
  }
  // lowest gate that meets target with at least one alert
  const meeting = sweep.filter((r) => r.nAlerts > 0 && r.precision >= targetPrecision);
  const achieved = meeting.length ? meeting.reduce((a, b) => (a.gate <= b.gate ? a : b)) : null;
  return { chosenGate: achieved?.gate ?? 0.95, achieved, sweep };
}

export interface BacktestReport {
  calibration: CalibrationResult;
  tuning: GateTuning;
}

export function renderReport(r: BacktestReport): string {
  const c = r.calibration;
  const lines: string[] = [];
  lines.push("TRDR calibration / backtest report");
  lines.push("=".repeat(40));
  lines.push("");
  lines.push("Band calibration (walk-forward):");
  lines.push(
    `  nominal ${pct(c.nominalCoverage)} band → empirical coverage ${pct(c.empiricalCoverage)} over ${c.n} sales`,
  );
  lines.push("");
  lines.push("Gate sweep (precision vs recall):");
  lines.push("  gate   alerts  precision  recall   medEdge");
  for (const s of r.tuning.sweep) {
    lines.push(
      `  ${s.gate.toFixed(2)}    ${String(s.nAlerts).padStart(4)}     ${pct(s.precision).padStart(5)}   ${pct(
        s.recall,
      ).padStart(5)}   $${s.medianRealizedEdge.toFixed(0)}`,
    );
  }
  lines.push("");
  if (r.tuning.achieved) {
    const a = r.tuning.achieved;
    lines.push(
      `Chosen gate ${a.gate.toFixed(2)} → precision ${pct(a.precision)}, recall ${pct(a.recall)}, ${a.nAlerts} alerts.`,
    );
  } else {
    lines.push("No gate met the precision target on this data — tighten the model or gather more comps.");
  }
  return lines.join("\n");
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
