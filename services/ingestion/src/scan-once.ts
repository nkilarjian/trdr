// CLI entry: one scan pass with the configured providers. `pnpm --filter @trdr/ingestion scan`
import { selectProviders } from "./providers.js";
import { scanOnce } from "./index.js";

const watched = [
  {
    key: { set: "2018 Panini Prizm Basketball", number: "280", variant: "Silver", grader: "PSA" as const, grade: 10 },
    resolutionConfidence: 1,
  },
];

async function main() {
  const alerts = await scanOnce(selectProviders(), watched, Date.parse("2026-06-13T12:00:00Z"));
  console.log(`${alerts.length} alert(s):`);
  for (const a of alerts) console.log(`  ${a.itemId}  edge $${a.expectedEdge.toFixed(0)}  ${a.deepLink}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
