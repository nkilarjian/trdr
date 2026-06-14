// §8 accumulation: build our OWN sold-comps dataset over time, for free.
// Each pass snapshots the active auctions for the watched cards; when an auction
// we saw before has ended and disappeared (with bids), we record its last-seen
// price as a real sold comp. Valuation then reads from this growing store — no
// gated sold-data API, no third-party subscription. It becomes the data moat.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalCardKey, SoldComp } from "@trdr/core";
import type { ActiveQuery, DateWindow, MarketDataProvider } from "@trdr/market-data";

export function keySig(k: CanonicalCardKey): string {
  return [k.set, k.number, k.variant ?? "", k.grader, k.grade, k.qualifier ?? ""].join("|");
}

/** Where the accumulated sold-comps live. Reader and recorder must agree. */
export function soldStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SOLD_STORE_PATH ?? fileURLToPath(new URL("../data/sold-comps.json", import.meta.url));
}

interface StoredSale {
  keySig: string;
  comp: SoldComp;
}
interface WatchEntry {
  price: number;
  endTime?: string;
  bidCount: number;
}
interface StoreData {
  sales: StoredSale[];
  watch: Record<string, Record<string, WatchEntry>>; // keySig → itemId → entry
}

/** File-backed sold-comps store. Simple JSON now; swap for Timescale at scale. */
export class SoldStore {
  constructor(private readonly path: string) {}

  load(): StoreData {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as StoreData;
    } catch {
      return { sales: [], watch: {} };
    }
  }

  save(data: StoreData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data, null, 2), "utf8");
  }

  /** Accumulated sold comps for a card within a window. */
  forKey(key: CanonicalCardKey, window?: DateWindow): SoldComp[] {
    const sig = keySig(key);
    const from = window ? Date.parse(window.fromIso) : -Infinity;
    const to = window ? Date.parse(window.toIso) : Infinity;
    return this.load()
      .sales.filter((s) => s.keySig === sig)
      .map((s) => s.comp)
      .filter((c) => {
        const t = Date.parse(c.soldAt);
        return t >= from && t <= to;
      });
  }
}

/**
 * One accumulation pass: for each watched card, snapshot its active auctions and
 * record any that ended since last time. Returns the number of new sales recorded.
 */
export async function accumulateSales(
  market: Pick<MarketDataProvider, "searchActive">,
  watched: CanonicalCardKey[],
  store: SoldStore,
  now = Date.now(),
): Promise<number> {
  const data = store.load();
  let recorded = 0;

  for (const key of watched) {
    const sig = keySig(key);
    const prev = data.watch[sig] ?? {};
    const query: ActiveQuery = { key, buyingOptions: ["AUCTION"] };
    const current = await market.searchActive(query);

    const curMap: Record<string, WatchEntry> = {};
    for (const l of current) curMap[l.itemId] = { price: l.currentPrice, endTime: l.endTime, bidCount: l.bidCount ?? 0 };

    // an auction we saw before, now gone, past its end, with bids → a real close
    for (const [itemId, e] of Object.entries(prev)) {
      if (!curMap[itemId] && e.bidCount > 0 && e.endTime && Date.parse(e.endTime) <= now) {
        data.sales.push({
          keySig: sig,
          comp: { itemId, soldPrice: e.price, soldAt: e.endTime, saleType: "auction-close", qty: 1, seller: { id: "observed" }, rawTitle: "" },
        });
        recorded++;
      }
    }
    data.watch[sig] = curMap;
  }

  store.save(data);
  return recorded;
}

/**
 * Wraps a MarketDataProvider so getSoldComps reads accumulated data first,
 * merged with whatever the inner provider returns (live source, if any).
 */
export class AccumulatingMarketDataProvider implements MarketDataProvider {
  constructor(
    private readonly inner: MarketDataProvider,
    private readonly store: SoldStore,
  ) {}

  searchActive(q: ActiveQuery) {
    return this.inner.searchActive(q);
  }
  getListing(itemId: string) {
    return this.inner.getListing(itemId);
  }

  async getSoldComps(key: CanonicalCardKey, window: DateWindow): Promise<SoldComp[]> {
    const accumulated = this.store.forKey(key, window);
    let live: SoldComp[] = [];
    try {
      live = await this.inner.getSoldComps(key, window);
    } catch {
      /* live source optional */
    }
    const seen = new Set<string>();
    return [...accumulated, ...live].filter((c) => {
      if (!c.itemId || seen.has(c.itemId)) return c.itemId === "" ? true : false;
      seen.add(c.itemId);
      return true;
    });
  }
}
