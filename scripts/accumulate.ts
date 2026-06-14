// One accumulation pass: snapshot watched auctions, record any that closed since
// last run. Schedule this (Windows Task Scheduler / cron) every ~15–30 min and
// the sold-comps dataset builds itself. Run: pnpm accumulate
//
// Uses real eBay when EBAY_CLIENT_ID/SECRET are set; otherwise it runs against
// mocks (which don't change, so nothing accumulates — that's expected).
import type { CanonicalCardKey } from "@trdr/core";
import { accumulateSales, selectProviders, SoldStore, soldStorePath } from "@trdr/ingestion";

// TODO: replace with the user's watchlist once that's wired. Seeded for now.
const WATCHED: CanonicalCardKey[] = [
  { set: "2018 Panini Prizm Basketball", number: "280", variant: "Silver", grader: "PSA", grade: 10 },
  { set: "2003-04 Topps Chrome Basketball", number: "111", grader: "CGC", grade: 9.5 },
  { set: "Base Set", number: "4", variant: "1st Edition", grader: "PSA", grade: 9 },
];

async function main() {
  const providers = selectProviders();
  const path = soldStorePath();
  const store = new SoldStore(path);
  const recorded = await accumulateSales(providers.market, WATCHED, store);
  console.log(`✓ accumulation pass: recorded ${recorded} new sold comp(s) → ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
