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

// Words that mark a comp as NOT the plain base card: premium parallels, inserts,
// color parallels, and other product lines. A base card only matches comps whose
// title contains none of these EXCEPT the ones already in its own set name (so a
// base "Prizm" card isn't rejected by the word "prizm", but a base "Mosaic" card
// rejects "prizm"/"genesis"/"silver"/… as different cards).
const NON_BASE_MARKERS = [
  // premium parallels & inserts
  "refractor", "x-fractor", "xfractor", "superfractor", "sapphire", "atomic", "genesis", "reactive", "choice",
  "camo", "disco", "mojo", "scope", "pulsar", "fluorescent", "cracked ice", "fast break", "no huddle", "press proof",
  "hyper", "shimmer", "velocity", "wave", "snakeskin", "kaleidoscope", "tmall", "downtown", "color blast",
  // color parallels (team-name colors red/blue/green/white/black left out to avoid false drops)
  "silver", "gold", "bronze", "platinum", "orange", "purple", "pink", "teal", "neon", "aqua", "lime", "magenta",
  // other major product lines — a base card should only match its OWN product
  "prizm", "optic", "select", "chrome", "contenders", "obsidian", "spectra", "certified", "phoenix",
  "illusions", "revolution", "immaculate", "flawless", "absolute", "playbook", "origins", "mosaic", "donruss",
];

function gradeFromTitle(title: string): number | null {
  const m = title.match(/\b(?:psa|cgc|sgc|bgs|bvg|beckett)\s*([0-9]{1,2}(?:\.5)?)\b/i);
  return m ? Number(m[1]) : null;
}

// A sold comp whose title contradicts the card key (wrong grade/parallel/product,
// an autograph, or a serial-numbered parallel) must be dropped before it can warp
// the value — the chokepoint covering BOTH accumulated and live comps. Blank
// titles (observed auction closes) are trusted.
export function compMatchesKey(title: string, key: CanonicalCardKey): boolean {
  const t = (title || "").toLowerCase();
  if (!t) return true;
  const g = gradeFromTitle(t);
  if (g != null && Math.abs(g - key.grade) > 0.01) return false; // wrong grade

  if (key.variant) {
    // A specific parallel (e.g. "Genesis", "Silver") must mention it in the title.
    return key.variant
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .every((w) => t.includes(w));
  }

  // Base/standard card: autographs and serial-numbered cards are never the base.
  if (/\bsigned\b|\bauto(?:graph|ed)?\b/.test(t)) return false;
  if (/\/\s*\d{1,4}\b/.test(t)) return false;
  // …and any parallel/insert/other-product word that isn't part of THIS set name.
  const set = (key.set ?? "").toLowerCase();
  return !NON_BASE_MARKERS.some((w) => t.includes(w) && !set.includes(w));
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
      if (!compMatchesKey(c.rawTitle, key)) return false; // wrong card/grade — would warp the value
      if (!c.itemId || seen.has(c.itemId)) return c.itemId === "" ? true : false;
      seen.add(c.itemId);
      return true;
    });
  }
}
