// ─── MarketDataProvider interface ───
// Active listings (eBay Browse — accessible) and historical sold comps
// (gated/short-window — do NOT hard-couple). Mock first.

import type { ActiveListing, CanonicalCardKey, SoldComp } from "@trdr/core";

export interface ActiveQuery {
  /** Free-text and/or canonical key constraints for the search. */
  keywords?: string;
  key?: Partial<CanonicalCardKey>;
  buyingOptions?: ("AUCTION" | "BIN")[];
  limit?: number;
}

export interface DateWindow {
  fromIso: string;
  toIso: string;
}

export interface MarketDataProvider {
  searchActive(q: ActiveQuery): Promise<ActiveListing[]>;
  getListing(itemId: string): Promise<ActiveListing | null>;
  getSoldComps(key: CanonicalCardKey, window: DateWindow): Promise<SoldComp[]>;
}

export { MockMarketDataProvider } from "./mock.js";
export { RealMarketDataProvider } from "./real.js";
export { TheCardApiMarketProvider } from "./thecardapi.js";
