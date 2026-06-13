"""Wire types — mirror packages/core/src/types.ts. Keep the two in sync."""
from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel

Grader = Literal["PSA", "CGC", "SGC", "BGS"]
SaleType = Literal["auction-close", "bin-accepted-offer", "bin-list"]


class SellerRef(BaseModel):
    id: str
    feedbackScore: Optional[int] = None
    feedbackPct: Optional[float] = None


class SoldComp(BaseModel):
    itemId: str
    soldPrice: float
    soldAt: str  # ISO
    saleType: SaleType
    qty: int = 1
    seller: SellerRef
    cert: Optional[str] = None
    rawTitle: str = ""


class StructuralPrior(BaseModel):
    point: float
    strength: float = 1.0


class FairValueRequest(BaseModel):
    comps: list[SoldComp]
    now_ms: int
    resolution_confidence: float = 1.0
    prior: Optional[StructuralPrior] = None


class FairValue(BaseModel):
    point: float
    lower: float
    upper: float
    confidence: float
    liquidity: float
    compCount: int
    dispersion: float
    shrunk: bool
