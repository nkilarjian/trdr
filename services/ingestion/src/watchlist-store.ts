// The user's watchlist (wishlist specs), persisted server-side so the background
// accumulation worker knows which cards to track even when the app isn't open.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { WishSpec } from "@trdr/core";

export function watchlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.WATCHLIST_PATH ?? fileURLToPath(new URL("../data/watchlist.json", import.meta.url));
}

export class WatchlistStore {
  constructor(private readonly path: string) {}

  load(): WishSpec[] {
    try {
      const v = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(v) ? (v as WishSpec[]) : [];
    } catch {
      return [];
    }
  }

  save(specs: WishSpec[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(specs, null, 2), "utf8");
  }
}
