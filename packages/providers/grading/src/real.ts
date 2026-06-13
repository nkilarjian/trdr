// Real GradingProvider — skeleton only. GATED: requires per-grader approval.

import type { CanonicalCardKey, Grader } from "@trdr/core";
import type { CertRecord, GradingProvider, PopReport } from "./index.js";

export interface RealGradingConfig {
  psaToken?: string;
  cgcToken?: string;
  sgcToken?: string;
  bgsToken?: string;
}

export class RealGradingProvider implements GradingProvider {
  constructor(readonly config: RealGradingConfig) {}

  async lookupCert(_grader: Grader, _cert: string): Promise<CertRecord | null> {
    // TODO(api-key): call PSA/CGC/SGC/BGS cert-verification endpoint for `grader`.
    //   PSA:  GET https://api.psacard.com/publicapi/cert/GetByCertNumber/{cert}  (PSA_API_TOKEN)
    //   CGC/SGC/BGS: equivalent gated endpoints. Normalize to CertRecord.
    throw new Error("RealGradingProvider.lookupCert not implemented — awaiting grader API approval");
  }

  async getPopulation(_key: CanonicalCardKey): Promise<PopReport | null> {
    // TODO(api-key): call the grader's population-report endpoint, normalize to PopReport.
    throw new Error("RealGradingProvider.getPopulation not implemented — awaiting grader API approval");
  }
}
