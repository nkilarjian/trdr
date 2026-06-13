"""Calibration/backtest harness (§9) — NON-NEGOTIABLE, a core feature.

Replays historical sold data, holds out, predicts, and measures:
  - band calibration (do 80% bands contain 80% of realized sales?)
  - alert precision (fraction of fired signals actually profitable net of fees)
  - the realized-edge distribution
Exposes a single tunable confidence gate targeting a precision goal (e.g. ≥85%)
and emits a human-readable report.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class CalibrationReport:
    band_coverage: dict[float, float] = field(default_factory=dict)  # nominal → empirical
    alert_precision: float = 0.0
    median_realized_edge: float = 0.0
    n_alerts: int = 0

    def render(self) -> str:
        lines = ["TRDR calibration report", "=" * 24]
        for nominal, empirical in sorted(self.band_coverage.items()):
            lines.append(f"  band {nominal:.0%}: empirical coverage {empirical:.1%}")
        lines.append(f"  alert precision: {self.alert_precision:.1%} over {self.n_alerts} alerts")
        lines.append(f"  median realized edge: ${self.median_realized_edge:,.0f}")
        return "\n".join(lines)


def run_backtest(_sold_history: list[dict]) -> CalibrationReport:
    # TODO(harness): walk-forward replay — hold out each sale, predict from the
    #   prior window, compare to realized close; bucket coverage and precision.
    raise NotImplementedError("run_backtest — Phase 1 (needs real/accumulated sold data)")
