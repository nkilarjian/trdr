// Harness invariants on deterministic synthetic data.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { generateHistory } from "./synthetic.js";
import { runBandCalibration, runAlertPrecision, tuneGate } from "./harness.js";

const NOW = Date.parse("2026-06-13T12:00:00Z");
const history = generateHistory({ nowMs: NOW, seed: 42 });

test("synthetic generator is deterministic for a fixed seed", () => {
  const a = generateHistory({ nowMs: NOW, seed: 7 });
  const b = generateHistory({ nowMs: NOW, seed: 7 });
  assert.deepEqual(a.sales[0], b.sales[0]);
  assert.equal(a.candidates.length, b.candidates.length);
});

test("band calibration produces a coverage in [0,1] over a non-trivial sample", () => {
  const c = runBandCalibration(history.sales);
  assert.ok(c.n > 10, "should evaluate many walk-forward points");
  assert.ok(c.empiricalCoverage >= 0 && c.empiricalCoverage <= 1);
});

test("raising the gate never increases the number of alerts (monotonic)", () => {
  let prev = Infinity;
  for (let g = 0.5; g <= 0.95; g += 0.1) {
    const r = runAlertPrecision(history.sales, history.candidates, Math.round(g * 100) / 100);
    assert.ok(r.nAlerts <= prev, `alerts should be non-increasing in gate (g=${g})`);
    prev = r.nAlerts;
  }
});

test("tuneGate, when it meets the target, actually meets it", () => {
  const t = tuneGate(history.sales, history.candidates, 0.85);
  if (t.achieved) {
    assert.ok(t.achieved.precision >= 0.85);
    assert.ok(t.achieved.nAlerts > 0);
    assert.equal(t.achieved.gate, t.chosenGate);
  }
  assert.ok(t.sweep.length >= 8, "should sweep a range of gates");
});
