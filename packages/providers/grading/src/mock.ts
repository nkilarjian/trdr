// Mock GradingProvider — fixtures, zero credentials. Lets the whole app run.

import type { CanonicalCardKey, Grader } from "@trdr/core";
import type { CertRecord, GradingProvider, PopReport } from "./index.js";

const CERTS: Record<string, CertRecord> = {
  "PSA:58127634": {
    grader: "PSA",
    cert: "58127634",
    grade: 10,
    set: "2018 Panini Prizm Basketball",
    number: "280",
    variant: "Silver",
    confidence: 0.98,
  },
  "PSA:58127699": {
    grader: "PSA",
    cert: "58127699",
    grade: 9,
    set: "2018 Panini Prizm Basketball",
    number: "280",
    variant: "Silver",
    confidence: 0.98,
  },
  "CGC:4012887001": {
    grader: "CGC",
    cert: "4012887001",
    grade: 9.5,
    set: "2003-04 Topps Chrome Basketball",
    number: "111",
    confidence: 0.97,
  },
  // additional cards a bulk photo scan resolves to
  "PSA:71045511": { grader: "PSA", cert: "71045511", grade: 9, set: "Base Set", number: "4", variant: "1st Edition", confidence: 0.97 },
  "PSA:62330180": { grader: "PSA", cert: "62330180", grade: 8, set: "1986 Fleer Basketball", number: "57", confidence: 0.96 },
  "SGC:9921007": { grader: "SGC", cert: "9921007", grade: 9, set: "1996 Topps Chrome Basketball", number: "138", confidence: 0.95 },
  "PSA:55012345": { grader: "PSA", cert: "55012345", grade: 10, set: "2018 Panini Prizm Basketball", number: "280", confidence: 0.98 },
};

const POPS: Record<string, PopReport> = {
  "PSA|2018 Panini Prizm Basketball|280|Silver|10": { atGrade: 412, higher: 0, total: 5230 },
  "PSA|2018 Panini Prizm Basketball|280|Silver|9": { atGrade: 1840, higher: 412, total: 5230 },
  // low-pop cards that drive "cool find" serendipity
  "CGC|2003-04 Topps Chrome Basketball|111||9.5": { atGrade: 60, higher: 8, total: 920 },
  "PSA|Base Set|4|1st Edition|9": { atGrade: 110, higher: 300, total: 4100 },
};

function popKey(k: CanonicalCardKey): string {
  return [k.grader, k.set, k.number, k.variant ?? "", k.grade].join("|");
}

export class MockGradingProvider implements GradingProvider {
  async lookupCert(grader: Grader, cert: string): Promise<CertRecord | null> {
    return CERTS[`${grader}:${cert}`] ?? null;
  }

  async getPopulation(key: CanonicalCardKey): Promise<PopReport | null> {
    return POPS[popKey(key)] ?? null;
  }
}
