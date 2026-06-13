"""Fair-value estimator (§6) — production home of the model.

This mirrors the TypeScript reference implementation in packages/core/src/model
so the runnable Phase-0 e2e (pure TS) and the production service agree. Port the
robust estimator here with numpy/scipy/statsmodels, then make this the single
source of truth and have the API call it over HTTP.

NOTE (Phase-0 deviation, intentional): the e2e demo runs the estimator in TS so
it needs no Python runtime. The numbers below are stubs until the port lands.
"""
from __future__ import annotations

import math

from .schemas import FairValueRequest, FairValue

RECENCY_LAMBDA = math.log(2) / 60.0  # 60-day half-life
SALE_TYPE_WEIGHT = {"auction-close": 1.0, "bin-accepted-offer": 0.5, "bin-list": 0.25}
SHRINKAGE_K0 = 6.0
BAND_K = 1.4826
MIN_COMPS_FOR_TRUST = 8


def compute_fair_value(req: FairValueRequest) -> FairValue:
    # TODO(port): replace with the full clean→robust-estimate→shrinkage pipeline
    #   (Theil–Sen trend projection, weighted median, MAD band, EB shrinkage).
    #   For now, a thin placeholder that keeps the service callable end-to-end.
    clean = [c for c in req.comps if c.qty == 1]
    if not clean:
        p = req.prior.point if req.prior else 0.0
        return FairValue(point=p, lower=p * 0.7, upper=p * 1.3, confidence=0.25 if req.prior else 0.0,
                         liquidity=0.0, compCount=0, dispersion=0.0, shrunk=bool(req.prior))

    prices = sorted(c.soldPrice for c in clean)
    point = prices[len(prices) // 2]
    half = max(point * 0.05, 1.0)
    return FairValue(point=point, lower=point - half, upper=point + half,
                     confidence=min(1.0, len(clean) / (len(clean) + MIN_COMPS_FOR_TRUST)),
                     liquidity=0.0, compCount=len(clean), dispersion=half, shrunk=False)
