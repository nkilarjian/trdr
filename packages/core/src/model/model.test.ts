// Unit tests for the model pipeline: cleaning, robust estimate, shrinkage, gate.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ActiveListing, SoldComp } from "../types.js";
import { cleanComps } from "./clean.js";
import { weightedMedian, theilSenSlope } from "./estimate.js";
import { computeFairValue } from "./fairvalue.js";
import { evaluateSignal } from "./signal.js";
import { DEFAULT_MODEL_CONFIG } from "@trdr/config";

const NOW = Date.parse("2026-06-13T12:00:00Z");

function comp(p: Partial<SoldComp> & { soldPrice: number; soldAt: string }): SoldComp {
  return {
    itemId: Math.random().toString(36).slice(2),
    saleType: "auction-close",
    qty: 1,
    seller: { id: "s", feedbackScore: 500, feedbackPct: 99 },
    rawTitle: "x",
    ...p,
  };
}

test("cleaning drops lots and shill wins", () => {
  const comps = [
    comp({ soldPrice: 300, soldAt: "2026-06-10T12:00:00Z" }),
    comp({ soldPrice: 600, soldAt: "2026-06-10T12:00:00Z", qty: 2 }), // lot
    comp({ soldPrice: 90, soldAt: "2026-06-10T12:00:00Z", seller: { id: "shill", feedbackScore: 1, feedbackPct: 80 } }),
  ];
  const cleaned = cleanComps(comps, DEFAULT_MODEL_CONFIG, { now: NOW });
  assert.equal(cleaned.length, 1);
});

test("weightedMedian and Theil–Sen behave", () => {
  assert.equal(weightedMedian([{ value: 1, weight: 1 }, { value: 3, weight: 1 }, { value: 2, weight: 1 }]), 2);
  // strictly increasing series ⇒ positive slope
  assert.ok(theilSenSlope([{ t: 0, y: 1 }, { t: 1, y: 2 }, { t: 2, y: 3 }]) > 0);
});

test("thin comps shrink toward the prior", () => {
  const fv = computeFairValue({
    comps: [comp({ soldPrice: 500, soldAt: "2026-06-12T12:00:00Z" })],
    now: NOW,
    prior: { point: 300 },
  });
  assert.ok(fv.shrunk, "single comp should be shrunk");
  assert.ok(fv.point < 500 && fv.point > 300, "shrunk between data and prior");
});

test("signal gate fires on real edge, suppresses thin confidence", () => {
  const listing: ActiveListing = {
    itemId: "x",
    title: "t",
    buyingOption: "BIN",
    currentPrice: 150,
    seller: { id: "s" },
    itemSpecifics: {},
    slabPhotoUrls: [],
  };
  const strong = { point: 300, lower: 290, upper: 310, confidence: 0.9, liquidity: 1, compCount: 12, dispersion: 8, shrunk: false };
  assert.equal(evaluateSignal(listing, strong).fire, true);

  const lowConf = { ...strong, confidence: 0.4 };
  assert.equal(evaluateSignal(listing, lowConf).fire, false);
});
