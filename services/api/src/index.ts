// TRDR API (Fastify). Phase 0: identity + alerts endpoints wired to providers
// (mock by default). Auth, portfolio, watchlists, eBay OAuth handoff, and push
// registration are stubbed with TODOs and land in Phase 1.

import Fastify from "fastify";
import { DefaultIdentityResolver } from "@trdr/identity";
import {
  buildFeed,
  DEMO_FEED_PARAMS,
  DEMO_WISHLIST,
  DEMO_WISHLIST_OPTS,
  scanOnce,
  scanWishlist,
  selectProviders,
  type WatchedKey,
} from "@trdr/ingestion";
import type { Grader } from "@trdr/core";

const providers = selectProviders();
const resolver = new DefaultIdentityResolver({
  grading: providers.grading,
  listingSource: { getListing: (id) => providers.market.getListing(id) },
});

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true, providers: process.env.TRDR_PROVIDERS ?? "mock" }));

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

// Wishlist: the auto-organized wish tree + background-scan hits "worth checking
// out" (good value or cool finds). Phase 1 serves the seeded demo wishlist; the
// POST variant (user-built wishlist) lands with persistence.
app.get("/api/v1/wishlist", async () => {
  return scanWishlist(providers, DEMO_WISHLIST, DEMO_WISHLIST_OPTS);
});

// TODO(Phase 1): POST /auth, eBay OAuth handoff (encrypt tokens at rest),
//   /portfolio, /watchlists (persist user wishlist), /devices (push registration).

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
