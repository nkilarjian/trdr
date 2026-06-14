// ─── Phase 0 end-to-end demo (mocks only, zero credentials) ───
// door → IdentityResolver → getSoldComps → fair-value band → scan active
// listings → close-forecast + signal gate → seller chip → alert.
//
// Run: pnpm e2e

import {
  buildAlert,
  computeFairValue,
  scoreSeller,
  type Alert,
  type CanonicalCardKey,
} from "@trdr/core";
import { MockGradingProvider } from "@trdr/grading";
import { MockMarketDataProvider } from "@trdr/market-data";
import { DefaultIdentityResolver } from "@trdr/identity";

// Fixed reference time so recency weighting is deterministic in the demo.
const NOW = Date.parse("2026-06-13T12:00:00Z");

async function main() {
  const grading = new MockGradingProvider();
  const market = new MockMarketDataProvider();
  const resolver = new DefaultIdentityResolver({
    grading,
    listingSource: { getListing: (id) => market.getListing(id) },
  });

  banner("1. Identity resolution (manual-cert door 5c)");
  const resolution = await resolver.fromCert("PSA", "58127634");
  console.log(`   key: ${fmtKey(resolution.key)}`);
  console.log(`   cert: ${resolution.cert}   confidence: ${pct(resolution.confidence)}`);

  banner("2. Fair value (clean → robust estimate → shrinkage → distribution)");
  const comps = await market.getSoldComps(resolution.key, {
    fromIso: "2026-01-01T00:00:00Z",
    toIso: "2026-06-13T12:00:00Z",
  });
  const fairValue = computeFairValue({
    comps,
    now: NOW,
    resolutionConfidence: resolution.confidence,
    prior: { point: 300, strength: 0.6 }, // structural prior (grade-ladder seed)
  });
  console.log(
    `   point $${fairValue.point.toFixed(0)}  band [$${fairValue.lower.toFixed(0)}, $${fairValue.upper.toFixed(0)}]`,
  );
  console.log(
    `   confidence ${pct(fairValue.confidence)}  comps ${fairValue.compCount}  liquidity ${fairValue.liquidity.toFixed(2)}/day  shrunk ${fairValue.shrunk}`,
  );

  banner("3. Scan active listings → signal gate → alerts");
  const listings = await market.searchActive({ key: resolution.key });
  const alerts: Alert[] = [];
  for (const listing of listings) {
    const sellerRisk = scoreSeller(listing.seller, {
      sampleSize: listing.seller.feedbackScore,
      shillRate: 0.05,
    });
    const alert = buildAlert({
      listing,
      key: resolution.key,
      fairValue,
      sellerRisk,
      epnCampaignId: "DEMO-EPN",
    });
    const verdict = alert
      ? `🔥 FIRE  edge $${alert.expectedEdge.toFixed(0)}  predClose $${alert.predictedClose.toFixed(0)}  seller:"${alert.sellerRisk.label}"`
      : "—  suppressed";
    console.log(`   ${listing.itemId.padEnd(22)} $${String(listing.currentPrice).padStart(4)} ${listing.buyingOption.padEnd(7)} ${verdict}`);
    if (alert) alerts.push(alert);
  }

  banner(`Result: ${alerts.length} underpriced alert(s)`);
  for (const a of alerts) {
    console.log(`   → ${a.itemId}  deep-link: ${a.deepLink}`);
  }
}

function banner(t: string) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}
function fmtKey(k: CanonicalCardKey): string {
  return `${k.set} #${k.number}${k.variant ? " " + k.variant : ""} ${k.grader} ${k.grade}`;
}
function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
