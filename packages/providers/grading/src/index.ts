// ─── GradingProvider interface ───
// cert number → card details + grade + qualifier + population. PSA/CGC/SGC/BGS.
// All real implementations are GATED (per-grader approval). Mock first.

import type { CanonicalCardKey, Grader, Qualifier } from "@trdr/core";

export interface CertRecord {
  grader: Grader;
  cert: string;
  grade: number;
  qualifier?: Qualifier;
  set: string;
  number: string;
  variant?: string;
  confidence: number; // grader-verified = high
}

export interface PopReport {
  atGrade: number; // population at this exact grade
  higher: number; // population graded higher
  total: number; // total graded across all grades
}

export interface GradingProvider {
  lookupCert(grader: Grader, cert: string): Promise<CertRecord | null>;
  getPopulation(key: CanonicalCardKey): Promise<PopReport | null>;
}

export { MockGradingProvider } from "./mock.js";
export { RealGradingProvider } from "./real.js";
