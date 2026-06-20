// Per-user library + wishlist, stored in Postgres and keyed to the Clerk user id.
// Everything degrades gracefully: with no DATABASE_URL / CLERK_SECRET_KEY the app
// just runs local-only (the sync endpoints report "not configured").

import pg from "pg";
import { verifyToken } from "@clerk/backend";

const DATABASE_URL = process.env.DATABASE_URL;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

export function syncConfigured(): boolean {
  return !!DATABASE_URL && !!CLERK_SECRET_KEY;
}

let pool: pg.Pool | null = null;
let ready: Promise<void> | null = null;

function getPool(): pg.Pool | null {
  if (!pool && DATABASE_URL) {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      // Railway/most managed Postgres need SSL; local does not.
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 4,
    });
  }
  return pool;
}

function ensureTable(p: pg.Pool): Promise<void> {
  if (!ready) {
    ready = p
      .query(
        `CREATE TABLE IF NOT EXISTS user_state (
           user_id    text PRIMARY KEY,
           library    jsonb NOT NULL DEFAULT '[]'::jsonb,
           wishlist   jsonb NOT NULL DEFAULT '[]'::jsonb,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined);
  }
  return ready;
}

export interface UserState {
  library: unknown[];
  wishlist: unknown[];
}

export async function getUserState(userId: string): Promise<UserState> {
  const p = getPool();
  if (!p) return { library: [], wishlist: [] };
  await ensureTable(p);
  const r = await p.query("SELECT library, wishlist FROM user_state WHERE user_id = $1", [userId]);
  if (!r.rows.length) return { library: [], wishlist: [] };
  return { library: r.rows[0].library ?? [], wishlist: r.rows[0].wishlist ?? [] };
}

export async function putUserState(userId: string, state: UserState): Promise<void> {
  const p = getPool();
  if (!p) return;
  await ensureTable(p);
  await p.query(
    `INSERT INTO user_state (user_id, library, wishlist, updated_at)
     VALUES ($1, $2::jsonb, $3::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE SET library = $2::jsonb, wishlist = $3::jsonb, updated_at = now()`,
    [userId, JSON.stringify(state.library ?? []), JSON.stringify(state.wishlist ?? [])],
  );
}

/** Verify a Clerk session token (Bearer …) → user id, or null if invalid/absent. */
export async function userIdFromAuth(authHeader?: string): Promise<string | null> {
  if (!CLERK_SECRET_KEY) return null;
  const token = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const claims = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
    return (claims.sub as string) ?? null;
  } catch {
    return null;
  }
}
