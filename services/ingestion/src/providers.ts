// Provider selection: mock (default, zero credentials) vs real (gated).
// Every service resolves providers through here so swapping to live data is
// a single env flag, never a code change in the pipeline.

import { MockGradingProvider, RealGradingProvider, type GradingProvider } from "@trdr/grading";
import { MockMarketDataProvider, RealMarketDataProvider, type MarketDataProvider } from "@trdr/market-data";
import { MockVisionProvider, RealVisionProvider, type VisionProvider } from "@trdr/vision";

export interface Providers {
  market: MarketDataProvider;
  grading: GradingProvider;
  vision: VisionProvider;
}

export function selectProviders(env: NodeJS.ProcessEnv = process.env): Providers {
  if (env.TRDR_PROVIDERS === "real") {
    return {
      market: new RealMarketDataProvider({
        ebayClientId: env.EBAY_CLIENT_ID,
        ebayClientSecret: env.EBAY_CLIENT_SECRET,
        soldPartnerKey: env.EBAY_SOLD_PARTNER_KEY,
      }),
      grading: new RealGradingProvider({
        psaToken: env.PSA_API_TOKEN,
        cgcToken: env.CGC_API_TOKEN,
        sgcToken: env.SGC_API_TOKEN,
        bgsToken: env.BGS_API_TOKEN,
      }),
      vision: new RealVisionProvider({ backend: env.VISION_BACKEND, endpointUrl: env.VISION_ENDPOINT_URL, apiKey: env.VISION_API_KEY }),
    };
  }
  return { market: new MockMarketDataProvider(), grading: new MockGradingProvider(), vision: new MockVisionProvider() };
}
