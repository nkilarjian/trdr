// TRDR API (Fastify). Phase 0: identity + alerts endpoints wired to providers
// (mock by default). Auth, portfolio, watchlists, eBay OAuth handoff, and push
// registration are stubbed with TODOs and land in Phase 1.

import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { DefaultIdentityResolver } from "@trdr/identity";
import {
  buildFeed,
  bulkIngest,
  DEMO_FEED_PARAMS,
  DEMO_LIBRARY,
  DEMO_LIBRARY_NOW,
  DEMO_WISHLIST,
  DEMO_WISHLIST_OPTS,
  LibraryStore,
  scanBoard,
  scanOnce,
  scanWishlist,
  selectProviders,
  valueLibrary,
  WatchlistStore,
  watchlistPath,
  type WatchedKey,
} from "@trdr/ingestion";
import type { Grader, Holding, WishSpec } from "@trdr/core";

// Load repo-root .env so credentials are picked up without exporting by hand
// (Node 20.12+/22+ built-in). Must run before selectProviders reads process.env.
try {
  (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* no .env — runs on mocks */
}

const providers = selectProviders();
const resolver = new DefaultIdentityResolver({
  grading: providers.grading,
  listingSource: { getListing: (id) => providers.market.getListing(id) },
});
const library = new LibraryStore(DEMO_LIBRARY);
const watchlist = new WatchlistStore(watchlistPath());

const app = Fastify({ logger: true });

// Allow the web app (a different origin when hosted, or :8081 in dev) to call us.
// CORS_ORIGIN can restrict it; default reflects any origin. (register loads
// before listen, so no top-level await needed.)
app.register(cors, { origin: process.env.CORS_ORIGIN ?? true });

// Capability report — which providers are backed by real credentials vs mocks.
// The app reads this to only surface real features (e.g. photo-scan needs vision)
// and to label values "live" vs "estimate" honestly.
const capabilities = {
  market: process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET ? "ebay" : "mock",
  vision: process.env.VISION_BACKEND === "claude" && process.env.ANTHROPIC_API_KEY ? "claude" : "mock",
  grading: process.env.PSA_API_TOKEN || process.env.CGC_API_TOKEN || process.env.SGC_API_TOKEN || process.env.BGS_API_TOKEN ? "real" : "mock",
};
app.get("/health", async () => ({ ok: true, providers: capabilities }));

// 5c — manual cert door
app.get<{ Params: { grader: string; cert: string } }>("/api/v1/resolve/cert/:grader/:cert", async (req) => {
  return resolver.fromCert(req.params.grader as Grader, req.params.cert);
});

// 5b — paste-a-listing door
app.get<{ Params: { itemId: string } }>("/api/v1/resolve/listing/:itemId", async (req) => {
  return resolver.fromListing(req.params.itemId);
});

// Alerts feed for a watched key (Phase 0: single key in the body)
app.post<{ Body: { watched: WatchedKey[] } }>("/api/v1/alerts", async (req) => {
  const alerts = await scanOnce(providers, req.body.watched ?? []);
  return { alerts };
});

// Client feed: alerts + card passport in one payload. The mobile app fetches
// this live and falls back to its bundled snapshot when unreachable. Same
// buildFeed() the snapshot generator uses, so the two never drift.
app.get<{ Querystring: { grader?: string; cert?: string } }>("/api/v1/feed", async (req) => {
  const grader = (req.query.grader as Grader) ?? DEMO_FEED_PARAMS.grader;
  const cert = req.query.cert ?? DEMO_FEED_PARAMS.cert;
  return buildFeed(providers, { ...DEMO_FEED_PARAMS, grader, cert });
});

// Wishlist (demo, seeded): the auto-organized tree + "worth checking out" hits.
app.get("/api/v1/wishlist", async () => {
  return scanWishlist(providers, DEMO_WISHLIST, DEMO_WISHLIST_OPTS);
});

// Board: everything driven by the USER's wishlist — deals + wishlist + passport.
// The posted wishlist is persisted as the watchlist so accumulation tracks the
// same cards. Empty body falls back to the demo wishlist.
app.post<{ Body: { specs?: WishSpec[] } }>("/api/v1/board", async (req) => {
  const specs = req.body?.specs?.length ? req.body.specs : DEMO_WISHLIST;
  if (req.body?.specs?.length) watchlist.save(specs);
  return scanBoard(providers, specs, { epnCampaignId: process.env.EBAY_EPN_CAMPAIGN_ID ?? "DEMO-EPN" });
});

// Library: the cards the user owns, valued by the model.
app.get("/api/v1/library", async () => {
  return { holdings: await valueLibrary(providers, library.all(), DEMO_LIBRARY_NOW) };
});

// Value the cards the CLIENT holds (the phone's on-device library). The app
// stores holdings locally; it posts them here to get live fair values back.
// Uncredentialed → mock values; with EBAY_* set → real eBay-backed valuation.
app.post<{ Body: { holdings?: Holding[] } }>("/api/v1/library/value", async (req) => {
  const holdings = (req.body?.holdings ?? []).filter((h) => h?.id && h?.key);
  if (!holdings.length) return { holdings: [] };
  return { holdings: await valueLibrary(providers, holdings) };
});

// Snap your collection: read many slabs from one photo, auto-add the confident
// reads to the library, and return the uncertain ones for quick confirmation.
app.post<{ Body: { image?: { uri?: string; base64?: string; mediaType?: string } } }>("/api/v1/library/scan", async (req) => {
  const result = await bulkIngest(providers, req.body?.image ?? {});
  library.addMany(result.added);
  const valued = await valueLibrary(providers, result.added, DEMO_LIBRARY_NOW);
  return { ...result, valued };
});

// TODO(Phase 1): POST /auth, eBay OAuth handoff (encrypt tokens at rest),
//   /portfolio, /watchlists (persist user wishlist), /devices (push registration).

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
