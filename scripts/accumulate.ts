// One accumulation pass: snapshot watched auctions, record any that closed since
// last run. Schedule this (Windows Task Scheduler / cron) every ~15–30 min and
// the sold-comps dataset builds itself. Run: pnpm accumulate
//
// Uses real eBay when EBAY_CLIENT_ID/SECRET are set; otherwise it runs against
// mocks (which don't change, so nothing accumulates — that's expected).
import type { CanonicalCardKey } from "@trdr/core";
import { accumulateSales, selectProviders, SoldStore, soldStorePath, WatchlistStore, watchlistPath, watchedKeys } from "@trdr/ingestion";

// Seed used only until the user has saved a watchlist (via the app).
const SEED: CanonicalCardKey[] = [
  { set: "2018 Panini Prizm Basketball", number: "280", variant: "Silver", grader: "PSA", grade: 10 },
  { set: "2003-04 Topps Chrome Basketball", number: "111", grader: "CGC", grade: 9.5 },
];

async function main() {
  const providers = selectProviders();
  const path = soldStorePath();
  const store = new SoldStore(path);

  const specs = new WatchlistStore(watchlistPath()).load();
  const watched = specs.length ? watchedKeys(specs) : SEED;

  const recorded = await accumulateSales(providers.market, watched, store);
  console.log(`✓ accumulation pass: ${watched.length} watched cards, recorded ${recorded} new sold comp(s) → ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
