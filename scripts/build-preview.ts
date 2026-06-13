// Generates a standalone, dependency-free HTML preview of TRDR's two signature
// screens — the alerts feed and the card "passport" — populated with REAL output
// from the model pipeline on mock data. No Expo/Tauri toolchain required; this is
// the "see it now" surface ahead of the RN clients (which reuse the same model +
// @trdr/ui view-models). Run: pnpm preview  →  opens apps/web/preview.html
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  buildAlert,
  computeFairValue,
  looksManipulated,
  scoreSeller,
  type Alert,
  type CanonicalCardKey,
  type SoldComp,
} from "@trdr/core";
import { alertVM, fairValueVM } from "@trdr/ui";
import { MockGradingProvider } from "@trdr/grading";
import { MockMarketDataProvider } from "@trdr/market-data";
import { DefaultIdentityResolver } from "@trdr/identity";

const NOW = Date.parse("2026-06-13T12:00:00Z");

async function buildData() {
  const grading = new MockGradingProvider();
  const market = new MockMarketDataProvider();
  const resolver = new DefaultIdentityResolver({ grading, listingSource: { getListing: (id) => market.getListing(id) } });

  const resolution = await resolver.fromCert("PSA", "58127634");
  const comps = await market.getSoldComps(resolution.key, { fromIso: "2026-01-01T00:00:00Z", toIso: "2026-06-13T12:00:00Z" });
  const fairValue = computeFairValue({ comps, now: NOW, resolutionConfidence: resolution.confidence, prior: { point: 300, strength: 0.6 } });
  const pop = await grading.getPopulation(resolution.key);

  const listings = await market.searchActive({});
  const alerts: Alert[] = [];
  for (const listing of listings) {
    const sellerRisk = scoreSeller(listing.seller, { sampleSize: listing.seller.feedbackScore, shillRate: 0.05 });
    const a = buildAlert({ listing, key: resolution.key, fairValue, sellerRisk, epnCampaignId: "DEMO-EPN", nowMs: NOW });
    if (a) alerts.push(a);
  }

  return { resolution, fairValue, pop, comps, alerts };
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
function usd(x: number): string {
  return `$${Math.round(x).toLocaleString("en-US")}`;
}
function keyTitle(k: CanonicalCardKey): string {
  return `${k.set} #${k.number}${k.variant ? " " + k.variant : ""}`;
}

function renderBody(data: Awaited<ReturnType<typeof buildData>>): string {
  const { resolution, fairValue, pop, comps, alerts } = data;
  const fv = fairValueVM(fairValue);
  const k = resolution.key;

  // band geometry for the passport visual
  const lo = fairValue.lower;
  const hi = fairValue.upper;
  const span = hi - lo || 1;
  const pointPct = ((fairValue.point - lo) / span) * 100;

  // show only comps that survived cleaning — never display rejected lots/shill
  const recent = [...comps]
    .filter((c: SoldComp) => c.qty === 1 && !looksManipulated(c))
    .sort((a: SoldComp, b: SoldComp) => Date.parse(b.soldAt) - Date.parse(a.soldAt))
    .slice(0, 6);

  const alertCards = alerts
    .map((a) => {
      const vm = alertVM(a);
      const toneClass = vm.sellerTone === "risk" ? "chip-risk" : vm.sellerTone === "caution" ? "chip-caution" : "chip-ok";
      return `
      <div class="alert">
        <div class="alert-top">
          <span class="badge ${a.buyingOption === "AUCTION" ? "badge-auction" : "badge-bin"}">${a.buyingOption}</span>
          <span class="alert-title">${esc(vm.title)}</span>
          <span class="edge">${esc(vm.edge)} edge</span>
        </div>
        <div class="alert-row">
          <div><span class="lbl">predicted close</span><b>${esc(vm.predictedClose)}</b></div>
          <div><span class="lbl">fair band</span><b>${esc(vm.band.range)}</b></div>
          <div><span class="lbl">confidence</span><b class="tone-${vm.band.confidenceTone}">${esc(vm.band.confidence)}</b></div>
          <div><span class="chip ${toneClass}">${esc(vm.sellerChip)}</span></div>
        </div>
        <a class="cta" href="${esc(vm.deepLink)}" target="_blank" rel="noreferrer">Open on eBay →</a>
      </div>`;
    })
    .join("");

  const compRows = recent
    .map(
      (c) => `<tr><td>${esc(c.soldAt.slice(0, 10))}</td><td class="num">${usd(c.soldPrice)}</td><td><span class="saletype">${esc(
        c.saleType,
      )}</span></td></tr>`,
    )
    .join("");

  return `
  <style>
    .trdr { --bg:#0b0e14; --panel:#141925; --panel2:#1b2230; --ink:#e6edf3; --muted:#8b97a8; --line:#232c3b;
      --green:#3fb950; --amber:#d29922; --red:#f85149; --accent:#58a6ff;
      font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; color:var(--ink);
      background:var(--bg); padding:22px; border-radius:14px; }
    .trdr * { box-sizing:border-box; }
    .hdr { display:flex; align-items:baseline; gap:12px; margin-bottom:18px; }
    .hdr h1 { font-size:20px; letter-spacing:2px; margin:0; font-weight:800; }
    .hdr .sub { color:var(--muted); font-size:12px; }
    .hdr .mode { margin-left:auto; font-size:11px; color:var(--muted); border:1px solid var(--line); padding:3px 8px; border-radius:20px; }
    .grid { display:grid; grid-template-columns: 1.15fr 1fr; gap:16px; }
    @media (max-width:780px){ .grid{ grid-template-columns:1fr; } }
    .col-h { font-size:11px; text-transform:uppercase; letter-spacing:1.5px; color:var(--muted); margin:0 0 10px; }

    .alert { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:10px; }
    .alert-top { display:flex; align-items:center; gap:9px; margin-bottom:9px; }
    .alert-title { font-weight:600; font-size:13px; }
    .edge { margin-left:auto; color:var(--green); font-weight:800; font-size:14px; }
    .badge { font-size:10px; font-weight:700; padding:2px 7px; border-radius:5px; letter-spacing:.5px; }
    .badge-auction { background:rgba(88,166,255,.15); color:var(--accent); }
    .badge-bin { background:rgba(63,185,80,.15); color:var(--green); }
    .alert-row { display:flex; gap:18px; align-items:center; flex-wrap:wrap; }
    .alert-row .lbl { display:block; font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
    .alert-row b { font-size:14px; }
    .cta { display:inline-block; margin-top:11px; font-size:12px; color:var(--accent); text-decoration:none; }
    .chip { font-size:11px; padding:3px 9px; border-radius:20px; border:1px solid var(--line); }
    .chip-ok { color:var(--green); border-color:rgba(63,185,80,.4); }
    .chip-caution { color:var(--amber); border-color:rgba(210,153,34,.4); }
    .chip-risk { color:var(--red); border-color:rgba(248,81,73,.4); }
    .tone-high{color:var(--green);} .tone-medium{color:var(--amber);} .tone-low{color:var(--red);}

    .passport { background:linear-gradient(180deg,var(--panel2),var(--panel)); border:1px solid var(--line);
      border-radius:12px; padding:18px; position:relative; overflow:hidden; }
    .passport::before { content:"GRADED PASSPORT"; position:absolute; top:12px; right:-28px; transform:rotate(35deg);
      background:var(--accent); color:#04122b; font-size:9px; font-weight:800; letter-spacing:1px; padding:3px 34px; }
    .pp-grade { display:flex; align-items:center; gap:10px; margin-bottom:4px; }
    .pp-grade .g { background:#04122b; color:var(--accent); border:1px solid rgba(88,166,255,.5); font-weight:800;
      font-size:13px; padding:3px 9px; border-radius:6px; }
    .pp-name { font-size:15px; font-weight:700; margin:2px 0 1px; }
    .pp-cert { font-size:11px; color:var(--muted); margin-bottom:16px; }
    .pp-point { font-size:34px; font-weight:800; letter-spacing:-1px; }
    .pp-point small { font-size:12px; color:var(--muted); font-weight:500; letter-spacing:0; }
    .band { position:relative; height:8px; background:var(--panel); border:1px solid var(--line); border-radius:6px; margin:14px 0 6px; }
    .band .fill { position:absolute; inset:0; background:linear-gradient(90deg,rgba(88,166,255,.15),rgba(63,185,80,.25)); border-radius:6px; }
    .band .pt { position:absolute; top:-4px; width:3px; height:16px; background:var(--ink); border-radius:2px; }
    .band-lbls { display:flex; justify-content:space-between; font-size:11px; color:var(--muted); }
    .meter { height:6px; background:var(--panel); border:1px solid var(--line); border-radius:6px; margin:6px 0 2px; overflow:hidden; }
    .meter .m { height:100%; }
    .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin:16px 0; }
    .stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:9px 10px; }
    .stat .v { font-size:16px; font-weight:700; } .stat .l { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
    table { width:100%; border-collapse:collapse; font-size:12px; }
    th { text-align:left; color:var(--muted); font-weight:500; font-size:10px; text-transform:uppercase; letter-spacing:.5px; padding:4px 0; }
    td { padding:5px 0; border-top:1px solid var(--line); } td.num { text-align:right; font-variant-numeric:tabular-nums; }
    .saletype { font-size:10px; color:var(--muted); }
    .foot { margin-top:14px; font-size:11px; color:var(--muted); line-height:1.5; }
  </style>

  <div class="trdr">
    <div class="hdr">
      <h1>TRDR</h1>
      <span class="sub">graded-card mispricing terminal</span>
      <span class="mode">providers: mock · live pipeline output</span>
    </div>

    <div class="grid">
      <div>
        <p class="col-h">Underpriced alerts · ${alerts.length}</p>
        ${alertCards || '<div class="alert">No alerts cleared the gate.</div>'}
      </div>

      <div>
        <p class="col-h">Card passport</p>
        <div class="passport">
          <div class="pp-grade"><span class="g">${esc(k.grader)} ${k.grade}</span><span class="pp-cert">cert ${esc(
            resolution.cert ?? "—",
          )}</span></div>
          <div class="pp-name">${esc(keyTitle(k))}</div>
          <div class="pp-point">${esc(fv.point)} <small>fair value</small></div>

          <div class="band"><div class="fill"></div><div class="pt" style="left:${pointPct.toFixed(1)}%"></div></div>
          <div class="band-lbls"><span>${esc(fv.range.split(" – ")[0] ?? "")}</span><span>80% band</span><span>${esc(
            fv.range.split(" – ")[1] ?? "",
          )}</span></div>

          <div class="meter"><div class="m tone-${fv.confidenceTone}" style="width:${(fairValue.confidence * 100).toFixed(
            0,
          )}%;background:currentColor"></div></div>
          <div class="band-lbls"><span>confidence</span><span class="tone-${fv.confidenceTone}">${esc(fv.confidence)}</span></div>

          <div class="stats">
            <div class="stat"><div class="v">${fairValue.compCount}</div><div class="l">clean comps</div></div>
            <div class="stat"><div class="v">${fairValue.liquidity.toFixed(2)}<small>/day</small></div><div class="l">liquidity</div></div>
            <div class="stat"><div class="v">${pop ? pop.atGrade.toLocaleString() : "—"}</div><div class="l">pop @ grade</div></div>
          </div>

          <table>
            <thead><tr><th>recent sale</th><th class="num">price</th><th>type</th></tr></thead>
            <tbody>${compRows}</tbody>
          </table>

          <div class="foot">Distribution, not a number. Band reflects sale dispersion; confidence reflects comp depth,
          tightness &amp; liquidity. Qualified copies (OC/MK) are segregated; lots, shill wins &amp; relists dropped before estimating.</div>
        </div>
      </div>
    </div>
  </div>`;
}

async function main() {
  const data = await buildData();
  const body = renderBody(data);
  const full = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>TRDR preview</title><style>body{margin:0;background:#05070b;}</style></head><body>${body}</body></html>`;

  const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "preview.html");
  writeFileSync(outPath, full, "utf8");

  console.log(`✓ wrote ${outPath}`);
  console.log(`  ${data.alerts.length} alerts · fair value ${usd(data.fairValue.point)} · confidence ${(data.fairValue.confidence * 100).toFixed(0)}%`);
  console.log(`  open it:  start "" "${outPath}"   (Windows)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
