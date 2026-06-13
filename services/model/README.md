# TRDR model service (Python / FastAPI)

Production home of the fair-value model (§6), seller scoring (§7b), the
mispricing/close-forecast engine (§7a), and the calibration/backtest harness (§9).

## Phase-0 status & one intentional deviation

The runnable Phase-0 e2e (`pnpm e2e` at the repo root) executes the model in
**TypeScript** (`packages/core/src/model`) so the whole pipeline runs with no
Python runtime and no credentials. This service is the faithful skeleton where
the production estimator + harness live; `app/estimator.py` is a thin placeholder
until the TS reference logic is ported here with numpy/scipy/statsmodels. Once
ported, this service becomes the single source of truth and the Node API calls it
over HTTP (`MODEL_SERVICE_URL`).

## Run (when Python is set up)

```bash
cd services/model
python -m venv .venv && . .venv/Scripts/activate   # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000
```
