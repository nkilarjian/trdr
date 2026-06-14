// Contract test — any VisionProvider must satisfy these. Run against the mock.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MockVisionProvider } from "./mock.js";

test("detectSlabs reads multiple slabs from one image, with confidences", async () => {
  const v = new MockVisionProvider();
  const slabs = await v.detectSlabs({ uri: "file://stack.jpg" });
  assert.ok(slabs.length >= 8, "should detect many cards in one photo");
  assert.ok(slabs.every((s) => s.confidence >= 0 && s.confidence <= 1));
  // a confident, cert-bearing read and a low-confidence one both exist
  assert.ok(slabs.some((s) => s.confidence >= 0.8 && s.certGuess));
  assert.ok(slabs.some((s) => s.confidence < 0.7));
});
