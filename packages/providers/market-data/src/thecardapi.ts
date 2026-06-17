// Real sold comps from The Card API (thecardapi.com) — actual transaction
// prices, including Best Offer accepts. We wrap a base provider for active
// listings (eBay/mock) and override getSoldComps with real sold data, which is
// far better for valuation than current listing asks. Falls back to the base
// provider whenever The Card API has nothing or errors.

import type { ActiveListing, CanonicalCardKey, SoldComp } from "@trdr/core";
import type { ActiveQuery, DateWindow, MarketDataProvider } from "./index.js";

const BASE = "https://thecardapi.com/api/v1/market";

interface TcaSale {
  id?: string | number;
  price?: number | string;
  sale_date?: string;
  sold_at?: string;
  grade?: string;
  grader?: string;
  title?: string;
}

export class TheCardApiMarketProvider implements MarketDataProvider {
  constructor(
    private readonly base: MarketDataProvider,
    private readonly apiKey: string,
  ) {}

  searchActive(q: ActiveQuery): Promise<ActiveListing[]> {
    return this.base.searchActive(q);
  }
  getListing(itemId: string): Promise<ActiveListing | null> {
    return this.base.getListing(itemId);
  }

  async getSoldComps(key: CanonicalCardKey, window: DateWindow): Promise<SoldComp[]> {
    // Build a full-text query that matches eBay-style sale titles: strip sport
    // words ("basketball"…) that never appear in titles, and drop the '#'.
    const setClean = key.set.replace(/\b(basketball|football|baseball|hockey|soccer|racing|f1)\b/gi, "").replace(/\s+/g, " ").trim();
    const q = [setClean, key.number, key.variant].filter(Boolean).join(" ").trim();
    if (q.length < 4) return this.base.getSoldComps(key, window); // API needs ≥4 chars
    const params = new URLSearchParams();
    params.set("q", q);
    if (key.grader) params.set("grader", key.grader);
    if (key.grade != null) params.set("grade", String(key.grade));
    // No date filter: the API's plan lookback (e.g. 7 days on free) already
    // bounds recency, and a wide date_from returns nothing on limited plans.
    void window;
    params.set("limit", "100");
    try {
      const res = await fetch(`${BASE}/sales?${params}`, { headers: { "x-market-api-key": this.apiKey } });
      if (!res.ok) {
        console.warn(`TheCardApi getSoldComps ${res.status}: ${await res.text()}; falling back to base`);
        return this.base.getSoldComps(key, window);
      }
      const body = (await res.json()) as { data?: TcaSale[] };
      const comps: SoldComp[] = (body.data ?? [])
        .map((s) => ({
          itemId: String(s.id ?? ""),
          soldPrice: Number(s.price ?? 0),
          soldAt: s.sold_at ?? (s.sale_date ? `${s.sale_date}T00:00:00Z` : new Date().toISOString()),
          saleType: "auction-close" as const, // real closed sale (model weights these high)
          qty: 1,
          seller: { id: "thecardapi" },
          rawTitle: s.title ?? "",
        }))
        .filter((c) => c.soldPrice > 0);
      // Nothing for this card on TCA → let the base provider (eBay) try.
      return comps.length ? comps : this.base.getSoldComps(key, window);
    } catch (err) {
      console.warn(`TheCardApi getSoldComps error (${(err as Error).message}); falling back to base`);
      return this.base.getSoldComps(key, window);
    }
  }
}
