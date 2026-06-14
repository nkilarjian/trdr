// Emits a JSON snapshot of real pipeline output for the mobile app to render
// offline (no server needed in Expo Go). Run: pnpm snapshot
// The app formats alerts with @trdr/ui; the passport is pre-shaped here so the
// client needs no @trdr/core runtime (only erased type imports).
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  buildAlert,
  computeFairValue,
  looksManipulated,
  scoreSeller,
  type Alert,
  type SoldComp,
} from "@trdr/core";
import { MockGradingProvider } from "@trdr/grading";
import { MockMarketDataProvider } from "@trdr/market-data";
import { DefaultIdentityResolver } from "@trdr/identity";

const NOW = Date.parse("2026-06-13T12:00:00Z");

async function main() {
  const grading = new MockGradingProvider();
  const market = new MockMarketDataProvider();
  const resolver = new DefaultIdentityResolver({ grading, listingSource: { getListing: (id) => market.getListing(id) } });

  const resolution = await resolver.fromCert("PSA", "58127634");
  const comps = await market.getSoldComps(resolution.key, { fromIso: "2026-01-01T00:00:00Z", toIso: "2026-06-13T12:00:00Z" });
  const fairValue = computeFairValue({ comps, now: NOW, resolutionConfidence: resolution.confidence, prior: { point: 300, strength: 0.6 } });
  const pop = await grading.getPopulation(resolution.key);

  const alerts: Alert[] = [];
  for (const listing of await market.searchActive({})) {
    const sellerRisk = scoreSeller(listing.seller, { sampleSize: listing.seller.feedbackScore, shillRate: 0.05 });
    const a = buildAlert({ listing, key: resolution.key, fairValue, sellerRisk, epnCampaignId: "DEMO-EPN", nowMs: NOW });
    if (a) alerts.push(a);
  }

  const recent = [...comps]
    .filter((c: SoldComp) => c.qty === 1 && !looksManipulated(c))
    .sort((a: SoldComp, b: SoldComp) => Date.parse(b.soldAt) - Date.parse(a.soldAt))
    .slice(0, 6)
    .map((c) => ({ date: c.soldAt.slice(0, 10), price: c.soldPrice, type: c.saleType }));

  const snapshot = {
    generatedAt: "2026-06-13T12:00:00Z",
    alerts,
    passport: {
      key: resolution.key,
      cert: resolution.cert ?? null,
      fairValue,
      pop,
      recent,
    },
  };

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "apps", "mobile", "assets");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "data.json");
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`✓ wrote ${outPath} (${alerts.length} alerts, fair $${fairValue.point.toFixed(0)})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
