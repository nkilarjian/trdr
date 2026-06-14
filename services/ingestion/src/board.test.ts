// scanBoard: the user's wishlist drives deals + wishlist + passport.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { scanBoard, specToKey, watchedKeys } from "./board.js";
import { DEMO_WISHLIST } from "./wishlist.js";
import { selectProviders } from "./providers.js";

const NOW = Date.parse("2026-06-13T12:00:00Z");

test("specToKey resolves a specific wish, null for a broad one", () => {
  assert.ok(specToKey(DEMO_WISHLIST[0]!)); // Luka PSA 10, fully specified
  assert.equal(specToKey({ id: "broad", subject: "Charizard" }), null);
});

test("watchedKeys dedupes resolvable wishes", () => {
  const keys = watchedKeys(DEMO_WISHLIST);
  assert.ok(keys.length >= 2);
  assert.ok(keys.every((k) => k.set && k.number && k.grader));
});

test("scanBoard produces deals + wishlist + passport from the wishlist", async () => {
  const providers = selectProviders(); // mocks (no env)
  const board = await scanBoard(providers, DEMO_WISHLIST, { nowMs: NOW, epnCampaignId: "DEMO-EPN" });
  assert.ok(board.alerts.length >= 1, "should surface deals across watched cards");
  assert.ok(board.wishlist.hits.length >= 1, "should surface wishlist hits");
  assert.ok(board.passport, "should value a passport card");
  // deals are de-duped by item
  const ids = board.alerts.map((a) => a.itemId);
  assert.equal(new Set(ids).size, ids.length);
});
