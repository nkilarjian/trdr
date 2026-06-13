"""FastAPI app — data in, scored output out. Pure and testable."""
from __future__ import annotations

from fastapi import FastAPI

from .estimator import compute_fair_value
from .schemas import FairValueRequest, FairValue

app = FastAPI(title="TRDR model service")


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/fair-value", response_model=FairValue)
def fair_value(req: FairValueRequest) -> FairValue:
    return compute_fair_value(req)


# TODO: POST /seller-score (§7b), POST /backtest (§9 harness report).
