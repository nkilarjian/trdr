# TRDR — graded trading-card portfolio & mispricing-signal app

> Working name (trademark pending). "Bloomberg terminal for graded cards" — not a scanner.

A cross-platform app (iOS / Android / desktop / web) for graded-card investors:
track a portfolio, value graded cards with explicit confidence, surface
**underpriced live auctions & BIN listings** as trustworthy alerts, and score
**sellers** for reliability and manipulation risk.

## Core principles (constrain every feature)

1. **Graded-only.** Identity comes from the slab (cert + grader + grade), never card-art CV.
2. **Honesty over false precision.** Every valuation is a distribution + confidence; low-confidence signals are suppressed.
3. **The signal must be realizable.** "Underpriced" fires only on real edge after fees + margin.
4. **Robust to dirty data.** Comp cleaning is a first-class subsystem.
5. **Advice, not execution (v1).** Deep-link to eBay; no auto-bidding until a flagged later phase.

## Architecture

```
clients (iOS/Android/desktop/web) → API (Fastify) → ingestion workers
                                          ↘ model service (FastAPI) ↘ Postgres/Timescale + Redis
external data behind interfaces: MarketDataProvider · GradingProvider · IdentityResolver
```

**All external data sits behind provider interfaces with Mock implementations.**
The whole app builds, runs, and tests end-to-end on fixtures with **zero credentials**.

## Layout

| Path | What |
|---|---|
| `packages/core` | shared types + the fair-value/seller/signal model (TS reference impl) |
| `packages/config` | versioned model tunables (band width, gate, fees) |
| `packages/ui` | shared, framework-agnostic view-models (RN components in Phase 1) |
| `packages/providers/market-data` | `MarketDataProvider` — eBay Browse / sold (mock + real-skeleton) |
| `packages/providers/grading` | `GradingProvider` — PSA/CGC/SGC/BGS cert + pop (mock + real-skeleton) |
| `packages/providers/identity` | `IdentityResolver` — the four input doors → one canonical key |
| `services/api` | Fastify API (identity + alerts wired; auth/portfolio Phase 1) |
| `services/ingestion` | active-listing scan loop → signal gate → alerts (§8 write-paths) |
| `services/model` | Python/FastAPI — production estimator + the §9 backtest harness |
| `apps/{mobile,desktop,web}` | client placeholders (Phase 1) |

## Quick start

```bash
pnpm install
pnpm e2e         # runnable Phase-0 pipeline on mocks: resolve → fair value → alerts
pnpm test        # unit + contract tests (model, identity, providers)
pnpm typecheck   # strict TS across the workspace
```

No `.env` needed — `TRDR_PROVIDERS=mock` (default) runs everything on fixtures.

## Credential gates (flagged, not blocking)

| Integration | Phase | Status |
|---|---|---|
| eBay Browse (active listings) | 1 | dev keys |
| eBay sold/transaction data | 1–2 | **gated** (partner or accumulation) |
| PSA/CGC/SGC/BGS cert + pop | 1 | **gated** (per-grader) |
| eBay EPN affiliate | 1 | EPN id |
| eBay Offer `placeProxyBid` | 3 | **feature-flagged OFF**, stub only |
| Expo Push / APNs / FCM | 1 | push certs |

See `.env.example` for every key (all unset by design).

## One intentional Phase-0 deviation

The model runs in **TypeScript** (`packages/core/src/model`) for the runnable e2e so
no Python runtime is required. `services/model` is the faithful Python skeleton where
the production estimator + backtest harness will live; the logic gets ported there
and the API then calls it over HTTP. Flagged in `services/model/README.md`.
