// Run the calibration / backtest harness on synthetic ground-truth data and
// print the report.  Run: pnpm backtest
import { generateHistory, runBandCalibration, tuneGate, renderReport } from "@trdr/core";

const NOW = Date.parse("2026-06-13T12:00:00Z");

const history = generateHistory({ nowMs: NOW, seed: 42 });
console.log(`synthetic history: ${history.sales.length} sold comps, ${history.candidates.length} alert candidates\n`);

const calibration = runBandCalibration(history.sales);
const tuning = tuneGate(history.sales, history.candidates, 0.85);

console.log(renderReport({ calibration, tuning }));
