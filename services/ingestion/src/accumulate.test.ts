// Accumulation recorder: an auction seen, then gone after its end, is recorded.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActiveListing, CanonicalCardKey } from "@trdr/core";
import { accumulateSales, SoldStore } from "./accumulate.js";

test("records a closed auction across two passes and reads it back", async () => {
  const key: CanonicalCardKey = { set: "2018 Prizm", number: "280", variant: "Silver", grader: "PSA", grade: 10 };
  const auction: ActiveListing = {
    itemId: "a1",
    title: "card",
    buyingOption: "AUCTION",
    currentPrice: 250,
    bidCount: 3,
    endTime: "2026-06-13T20:00:00Z",
    seller: { id: "s" },
    itemSpecifics: {},
    slabPhotoUrls: [],
  };

  let listings: ActiveListing[] = [auction];
  const market = { searchActive: async () => listings };
  const store = new SoldStore(join(tmpdir(), `trdr-sold-test-${process.pid}-${Date.now()}.json`));
  const now = Date.parse("2026-06-14T00:00:00Z"); // after the auction's end

  // pass 1: just snapshots the live auction (nothing recorded yet)
  assert.equal(await accumulateSales(market, [key], store, now), 0);

  // auction has ended and dropped off
  listings = [];
  // pass 2: it's gone + past end + had bids → recorded as a sold comp
  assert.equal(await accumulateSales(market, [key], store, now), 1);

  const comps = store.forKey(key);
  assert.equal(comps.length, 1);
  assert.equal(comps[0]!.soldPrice, 250);
  assert.equal(comps[0]!.saleType, "auction-close");

  // a card with no observed sales returns nothing
  assert.equal(store.forKey({ ...key, number: "999" }).length, 0);
});
