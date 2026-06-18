// Real MarketDataProvider — eBay APIs.
//   • Active listings  → Browse API (accessible with standard dev keys).
//   • Sold comps       → Marketplace Insights API (SEPARATELY GATED: apply for
//     limited access). Falls back to [] so the app degrades gracefully (real
//     listings still show; valuation just stays low-confidence) until granted.

import type { ActiveListing, CanonicalCardKey, SoldComp } from "@trdr/core";
import type { ActiveQuery, DateWindow, MarketDataProvider } from "./index.js";

export interface RealMarketDataConfig {
  ebayClientId?: string;
  ebayClientSecret?: string;
  soldPartnerKey?: string; // reserved: a non-eBay sold-comps source, if used
  marketplaceId?: string; // e.g. "EBAY_US"
  /** Redis-backed token bucket for the eBay rate-limit budget. */
  rateLimiter?: { take(cost: number): Promise<boolean> };
}

const OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const BROWSE = "https://api.ebay.com/buy/browse/v1";
const INSIGHTS = "https://api.ebay.com/buy/marketplace_insights/v1_beta";

export class RealMarketDataProvider implements MarketDataProvider {
  private token?: { value: string; expiresAt: number };

  constructor(private readonly config: RealMarketDataConfig) {}

  async searchActive(q: ActiveQuery): Promise<ActiveListing[]> {
    const params = new URLSearchParams();
    params.set("q", queryFor(q));
    params.set("limit", String(q.limit ?? 50));
    if (q.buyingOptions?.length) {
      const opts = q.buyingOptions.map((b) => (b === "AUCTION" ? "AUCTION" : "FIXED_PRICE")).join("|");
      params.set("filter", `buyingOptions:{${opts}}`);
    }
    const data = await this.get<{ itemSummaries?: EbayItemSummary[] }>(`${BROWSE}/item_summary/search?${params}`);
    return (data.itemSummaries ?? []).map(toListing);
  }

  async getListing(itemId: string): Promise<ActiveListing | null> {
    try {
      const item = await this.get<EbayItem>(`${BROWSE}/item/${encodeURIComponent(itemId)}`);
      return toListing(item);
    } catch {
      return null;
    }
  }

  async getSoldComps(key: CanonicalCardKey, window: DateWindow): Promise<SoldComp[]> {
    // Marketplace Insights is gated; without access this 403s. Degrade to [].
    const params = new URLSearchParams();
    params.set("q", keyQuery(key));
    params.set("filter", `lastSoldDate:[${window.fromIso}..${window.toIso}]`);
    params.set("limit", "100");
    try {
      const data = await this.get<{ itemSales?: EbayItemSale[] }>(`${INSIGHTS}/item_sales/search?${params}`);
      return (data.itemSales ?? []).map(toSoldComp);
    } catch (err) {
      console.warn(`getSoldComps: no Marketplace Insights access (${(err as Error).message}); falling back to current BIN asks (low confidence)`);
      // Interim proxy until real sold data: treat current BIN asking prices as
      // weak "bin-list" comps. The model weights bin-list lowest, so confidence
      // stays low — better than an empty app, clearly labelled as a rough guess.
      const asks = await this.searchActive({ key, buyingOptions: ["BIN"], limit: 25 });
      return asks
        .filter((l) => l.currentPrice > 0)
        .map((l) => ({ itemId: l.itemId, soldPrice: l.currentPrice, soldAt: new Date().toISOString(), saleType: "bin-list" as const, qty: 1, seller: l.seller, rawTitle: l.title }));
    }
  }

  // ── eBay plumbing ──

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 30_000) return this.token.value;
    if (!this.config.ebayClientId || !this.config.ebayClientSecret) throw new Error("eBay client id/secret not configured");

    const basic = Buffer.from(`${this.config.ebayClientId}:${this.config.ebayClientSecret}`).toString("base64");
    const res = await fetch(OAUTH_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
    });
    if (!res.ok) throw new Error(`eBay OAuth ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: now + json.expires_in * 1000 };
    return this.token.value;
  }

  private async get<T>(url: string): Promise<T> {
    if (this.config.rateLimiter) await this.config.rateLimiter.take(1);
    const token = await this.accessToken();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": this.config.marketplaceId ?? "EBAY_US" },
    });
    if (!res.ok) throw new Error(`eBay ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }
}

// ── query building ──

// eBay lists players in plain ASCII ("Luka Doncic"), so a query carrying accents
// ("Dončić") matches almost nothing. Strip diacritics from every search.
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function queryFor(q: ActiveQuery): string {
  // Combine the keywords (player/subject) AND the card key. Using only one meant a
  // wishlist search was JUST the player name — too broad, often empty, and it
  // ignored the set/number/grade entirely.
  const parts: string[] = [];
  if (q.keywords) parts.push(q.keywords);
  if (q.key) parts.push(keyQuery(q.key));
  const query = parts.length ? parts.join(" ") : "graded trading card";
  return stripAccents(query).replace(/\s+/g, " ").trim();
}
function keyQuery(k: Partial<CanonicalCardKey>): string {
  return [k.set, k.number ? `#${k.number}` : "", k.variant, k.grader, k.grade].filter(Boolean).join(" ").trim();
}

// ── eBay response shapes (subset) → domain types ──

interface EbayItemSummary {
  itemId: string;
  title: string;
  price?: { value: string };
  currentBidPrice?: { value: string };
  bidCount?: number;
  itemEndDate?: string;
  buyingOptions?: string[];
  seller?: { username?: string; feedbackScore?: number; feedbackPercentage?: string };
  image?: { imageUrl?: string };
  thumbnailImages?: { imageUrl?: string }[];
  additionalImages?: { imageUrl?: string }[];
  localizedAspects?: { name: string; value: string }[];
}
type EbayItem = EbayItemSummary;

interface EbayItemSale {
  itemId?: string;
  lastSoldPrice?: { value: string };
  lastSoldDate?: string;
  buyingOptions?: string[];
  seller?: { username?: string; feedbackScore?: number; feedbackPercentage?: string };
  title?: string;
}

function toListing(s: EbayItemSummary): ActiveListing {
  const isAuction = (s.buyingOptions ?? []).includes("AUCTION");
  const currentPrice = Number((isAuction ? s.currentBidPrice?.value : s.price?.value) ?? s.price?.value ?? 0);
  const slabPhotoUrls = [s.image?.imageUrl, ...(s.thumbnailImages ?? []).map((i) => i.imageUrl), ...(s.additionalImages ?? []).map((i) => i.imageUrl)].filter(
    (u): u is string => typeof u === "string",
  );
  const itemSpecifics: Record<string, string> = {};
  for (const a of s.localizedAspects ?? []) itemSpecifics[a.name] = a.value;
  return {
    itemId: s.itemId,
    title: s.title,
    buyingOption: isAuction ? "AUCTION" : "BIN",
    currentPrice,
    bidCount: s.bidCount,
    endTime: s.itemEndDate,
    seller: sellerRef(s.seller),
    itemSpecifics,
    slabPhotoUrls,
  };
}

function toSoldComp(s: EbayItemSale): SoldComp {
  const isAuction = (s.buyingOptions ?? []).includes("AUCTION");
  return {
    itemId: s.itemId ?? "",
    soldPrice: Number(s.lastSoldPrice?.value ?? 0),
    soldAt: s.lastSoldDate ?? new Date().toISOString(),
    saleType: isAuction ? "auction-close" : "bin-list",
    qty: 1,
    seller: sellerRef(s.seller),
    rawTitle: s.title ?? "",
  };
}

function sellerRef(s?: { username?: string; feedbackScore?: number; feedbackPercentage?: string }) {
  return { id: s?.username ?? "unknown", feedbackScore: s?.feedbackScore, feedbackPct: s?.feedbackPercentage ? Number(s.feedbackPercentage) : undefined };
}
