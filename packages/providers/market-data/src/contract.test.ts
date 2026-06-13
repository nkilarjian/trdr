// Contract test — any MarketDataProvider must satisfy these. Run against the mock.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MockMarketDataProvider } from "./mock.js";

const KEY = {
  set: "2018 Panini Prizm Basketball",
  number: "280",
  variant: "Silver",
  grader: "PSA" as const,
  grade: 10,
};

test("searchActive returns listings and respects the buyingOptions filter", async () => {
  const p = new MockMarketDataProvider();
  const all = await p.searchActive({});
  assert.ok(all.length >= 2);
  const bins = await p.searchActive({ buyingOptions: ["BIN"] });
  assert.ok(bins.every((l) => l.buyingOption === "BIN"));
});

test("getSoldComps returns comps within the window, including dirty fixtures", async () => {
  const p = new MockMarketDataProvider();
  const comps = await p.getSoldComps(KEY, { fromIso: "2026-01-01T00:00:00Z", toIso: "2026-06-13T00:00:00Z" });
  assert.ok(comps.length >= 8);
  assert.ok(comps.some((c) => c.qty > 1), "fixture should include a lot for the cleaner to drop");
});

test("getListing resolves a known itemId and null otherwise", async () => {
  const p = new MockMarketDataProvider();
  assert.ok(await p.getListing("v-underpriced-auction"));
  assert.equal(await p.getListing("nope"), null);
});
