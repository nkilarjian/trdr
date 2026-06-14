// Wishlist: auto-hierarchy, parsing, and interest scoring.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildWishTree, countWishes, parseWish, scoreInterest, type WishSpec } from "./wishlist.js";

test("buildWishTree auto-organizes flat wishes and shares parent nodes", () => {
  const specs: WishSpec[] = [
    { id: "w1", category: "Basketball", subject: "Luka Dončić", set: "2018 Panini Prizm", number: "280", variant: "Silver", grader: "PSA", minGrade: 10 },
    { id: "w2", category: "Basketball", subject: "Luka Dončić", set: "2018 Panini Prizm", number: "280", grader: "PSA", minGrade: 9 },
    { id: "w3", category: "Pokémon", subject: "Charizard" }, // broad wish, few levels
  ];
  const root = buildWishTree(specs);

  // two categories under root
  assert.equal(root.children.length, 2);
  const basketball = root.children.find((c) => c.label === "Basketball")!;
  // Luka is a single shared subject node...
  assert.equal(basketball.children.length, 1);
  const luka = basketball.children[0]!;
  assert.equal(luka.label, "Luka Dončić");
  // ...one set...
  const set = luka.children[0]!;
  // ...two distinct cards (#280 Silver vs #280) OR same card w/ two grades — either way 2 leaves
  assert.equal(countWishes(root), 3);

  // broad Charizard wish becomes a shallow leaf tagged with its wishId
  const pokemon = root.children.find((c) => c.label === "Pokémon")!;
  assert.equal(pokemon.children[0]!.label, "Charizard");
  assert.equal(pokemon.children[0]!.wishId, "w3");
  assert.equal(set.spec.set, "2018 Panini Prizm");
});

test("parseWish extracts grader, grade, and subject from free text", () => {
  const s = parseWish("Luka Prizm PSA 10", "w1");
  assert.equal(s.grader, "PSA");
  assert.equal(s.minGrade, 10);
  assert.ok((s.subject ?? "").toLowerCase().includes("luka"));
});

test("scoreInterest flags good value", () => {
  const r = scoreInterest({ currentPrice: 110, buyingOption: "AUCTION", expectedEdge: 80, fairPoint: 300, confidence: 0.8 });
  assert.ok(r.value >= 0.4);
  assert.ok(r.worthIt);
  assert.ok(r.tags.includes("good value"));
});

test("scoreInterest flags cool finds (low pop + gem grade + sleeper)", () => {
  const r = scoreInterest({ currentPrice: 200, buyingOption: "AUCTION", bidCount: 1, hoursLeft: 3, popAtGrade: 40, grade: 10, variant: "Silver" });
  assert.ok(r.cool >= 0.5);
  assert.ok(r.worthIt);
  assert.ok(r.tags.includes("low pop"));
  assert.ok(r.tags.includes("gem grade"));
  assert.ok(r.tags.includes("sleeper"));
});

test("scoreInterest respects budget", () => {
  const r = scoreInterest({ currentPrice: 500, buyingOption: "BIN", maxPrice: 300, popAtGrade: 40, grade: 10 });
  assert.ok(r.overBudget);
  assert.equal(r.worthIt, false);
});
