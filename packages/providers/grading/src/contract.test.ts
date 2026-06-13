// Contract test — any GradingProvider must satisfy these. Run against the mock.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MockGradingProvider } from "./mock.js";

test("lookupCert returns a normalized CertRecord for a known cert", async () => {
  const p = new MockGradingProvider();
  const rec = await p.lookupCert("PSA", "58127634");
  assert.ok(rec, "expected a cert record");
  assert.equal(rec!.grade, 10);
  assert.equal(rec!.set, "2018 Panini Prizm Basketball");
  assert.ok(rec!.confidence > 0.9);
});

test("lookupCert returns null for an unknown cert", async () => {
  const p = new MockGradingProvider();
  assert.equal(await p.lookupCert("PSA", "00000000"), null);
});

test("getPopulation returns a pop report for a known key", async () => {
  const p = new MockGradingProvider();
  const pop = await p.getPopulation({
    set: "2018 Panini Prizm Basketball",
    number: "280",
    variant: "Silver",
    grader: "PSA",
    grade: 10,
  });
  assert.ok(pop && pop.total > pop.atGrade);
});
