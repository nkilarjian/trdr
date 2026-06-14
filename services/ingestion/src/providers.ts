// Provider selection: mock (default, zero credentials) vs real (gated).
// Every service resolves providers through here so swapping to live data is
// a single env flag, never a code change in the pipeline.

import { MockGradingProvider, RealGradingProvider, type GradingProvider } from "@trdr/grading";
import { MockMarketDataProvider, RealMarketDataProvider, type MarketDataProvider } from "@trdr/market-data";
import { MockVisionProvider, RealVisionProvider, type VisionProvider } from "@trdr/vision";
import { AccumulatingMarketDataProvider, SoldStore, soldStorePath } from "./accumulate.js";

export interface Providers {
  market: MarketDataProvider;
  grading: GradingProvider;
  vision: VisionProvider;
}

// Each provider goes real as soon as its own credentials are present — so you
// can run real eBay listings while grading/vision stay mock, etc.
export function selectProviders(env: NodeJS.ProcessEnv = process.env): Providers {
  let market: MarketDataProvider;
  if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
    const ebay = new RealMarketDataProvider({
      ebayClientId: env.EBAY_CLIENT_ID,
      ebayClientSecret: env.EBAY_CLIENT_SECRET,
      soldPartnerKey: env.EBAY_SOLD_PARTNER_KEY,
      marketplaceId: env.EBAY_MARKETPLACE_ID,
    });
    // valuation reads our accumulated sold comps first, merged with any live source
    market = new AccumulatingMarketDataProvider(ebay, new SoldStore(soldStorePath(env)));
  } else {
    market = new MockMarketDataProvider();
  }

  const grading =
    env.PSA_API_TOKEN || env.CGC_API_TOKEN || env.SGC_API_TOKEN || env.BGS_API_TOKEN
      ? new RealGradingProvider({ psaToken: env.PSA_API_TOKEN, cgcToken: env.CGC_API_TOKEN, sgcToken: env.SGC_API_TOKEN, bgsToken: env.BGS_API_TOKEN })
      : new MockGradingProvider();

  const vision =
    env.VISION_BACKEND === "claude" && env.ANTHROPIC_API_KEY
      ? new RealVisionProvider({ backend: "claude", anthropicApiKey: env.ANTHROPIC_API_KEY, model: env.VISION_MODEL })
      : new MockVisionProvider();

  return { market, grading, vision };
}
