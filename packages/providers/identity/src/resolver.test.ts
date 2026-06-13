// IdentityResolver tests — barcode/OCR/listing/cert/catalog + confidence assignment.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MockGradingProvider } from "@trdr/grading";
import { DefaultIdentityResolver } from "./resolver.js";
import type { ListingSource } from "./index.js";

const grading = new MockGradingProvider();

test("manual cert resolves to the canonical key with high confidence", async () => {
  const r = new DefaultIdentityResolver({ grading });
  const res = await r.fromCert("PSA", "58127634");
  assert.equal(res.key.number, "280");
  assert.equal(res.key.grade, 10);
  assert.ok(res.confidence > 0.85, "machine-read cert should be high confidence");
});

test("slab scan via barcode beats OCR confidence", async () => {
  const r = new DefaultIdentityResolver({ grading });
  const barcode = await r.fromSlabScan({ barcodePayload: "PSA|58127634" });
  const ocr = await r.fromSlabScan({ ocrText: "PSA 10 Cert 58127634", graderHint: "PSA" });
  assert.equal(barcode.key.number, "280");
  assert.equal(ocr.key.number, "280");
  assert.ok(barcode.confidence > ocr.confidence, "barcode should outrank OCR");
});

test("listing without a readable cert falls back to stated card at lower confidence", async () => {
  const source: ListingSource = {
    async getListing() {
      return {
        title: "2018 Prizm Luka #280 PSA 10",
        itemSpecifics: { Grader: "PSA", Grade: "10", Set: "2018 Panini Prizm Basketball", Number: "280" },
      };
    },
  };
  const r = new DefaultIdentityResolver({ grading, listingSource: source });
  const res = await r.fromListing("v-stated-only");
  assert.equal(res.key.number, "280");
  assert.ok(res.confidence < 0.7, "stated-only must be lower confidence than a read cert");
  assert.ok(res.warnings.some((w) => w.includes("stated")));
});

test("catalog search returns a card-type key at modest confidence", async () => {
  const r = new DefaultIdentityResolver({ grading });
  const res = await r.fromCatalog({ text: "Luka", grader: "PSA", grade: 10 });
  assert.equal(res.key.set, "2018 Panini Prizm Basketball");
  assert.ok(res.confidence <= 0.65);
});

test("unknown cert resolves to zero confidence with a warning", async () => {
  const r = new DefaultIdentityResolver({ grading });
  const res = await r.fromCert("PSA", "00000000");
  assert.equal(res.confidence, 0);
  assert.ok(res.warnings.length > 0);
});
