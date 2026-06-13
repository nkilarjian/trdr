// Real MarketDataProvider — skeleton. Browse is accessible; sold is GATED.

import type { ActiveListing, CanonicalCardKey, SoldComp } from "@trdr/core";
import type { ActiveQuery, DateWindow, MarketDataProvider } from "./index.js";

export interface RealMarketDataConfig {
  ebayClientId?: string;
  ebayClientSecret?: string;
  soldPartnerKey?: string;
  /** Redis-backed token bucket for the eBay rate-limit budget. */
  rateLimiter?: { take(cost: number): Promise<boolean> };
}

export class RealMarketDataProvider implements MarketDataProvider {
  constructor(readonly config: RealMarketDataConfig) {}

  async searchActive(_q: ActiveQuery): Promise<ActiveListing[]> {
    // TODO(api-key): eBay Browse API item_summary/search with buyingOptions filter.
    //   GET https://api.ebay.com/buy/browse/v1/item_summary/search
    //   OAuth client-credentials (EBAY_CLIENT_ID/SECRET). Respect rateLimiter.
    throw new Error("RealMarketDataProvider.searchActive not implemented — awaiting eBay dev keys");
  }

  async getListing(_itemId: string): Promise<ActiveListing | null> {
    // TODO(api-key): eBay Browse getItem by itemId.
    throw new Error("RealMarketDataProvider.getListing not implemented — awaiting eBay dev keys");
  }

  async getSoldComps(_key: CanonicalCardKey, _window: DateWindow): Promise<SoldComp[]> {
    // TODO(gated): sold/transaction data via partner (soldPartnerKey) or local accumulation.
    //   Until access lands, ingestion accumulates observed closes into Timescale and
    //   this method reads from that store. DO NOT hard-couple to a single vendor.
    throw new Error("RealMarketDataProvider.getSoldComps not implemented — gated sold-data access");
  }
}
