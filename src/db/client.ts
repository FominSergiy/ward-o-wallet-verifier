// Postgres access for the wallet-verifier backend.
//
// Host = Neon (managed serverless Postgres). Driver = postgres.js, reached
// ONLY through getDb() — never instantiate a client elsewhere. Config is a
// single DATABASE_URL: the Neon pooled endpoint in prod, a Neon dev branch
// locally (no Docker).
//
// When DATABASE_URL is unset the client is a no-op: every query resolves to
// an empty array and no socket is opened. This keeps `deno task test` fully
// offline-safe (mirrors the HEALTH_TRACKING pattern in
// src/discovery/health_store.ts). DB-dependent tests gate on DATABASE_URL.
//
// If Deno Deploy connection limits ever bite, swap the postgres.js client for
// the @neondatabase/serverless HTTP driver behind this same getDb() — callers
// never touch the driver directly, so the change stays local to this file.

import postgres from "postgres";

export type Sql = postgres.Sql<Record<string, never>>;

// A getDb() result is either a live postgres.js tagged-template client or the
// no-op stand-in below. Both are callable as a tagged template returning a
// promise of rows, which is all the rest of the codebase needs.
export type Db = Sql | NoopDb;

// Minimal no-op that satisfies the tagged-template call shape. Any query
// resolves to an empty array; end() is a no-op. Intentionally narrow — it is
// not a full postgres.js client and should only be used for reads/writes that
// tolerate "nothing happened" in test/offline mode.
export interface NoopDb {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<never[]>;
  readonly noop: true;
  end(): Promise<void>;
}

function makeNoop(): NoopDb {
  const fn = (() => Promise.resolve([])) as unknown as NoopDb;
  Object.defineProperty(fn, "noop", { value: true });
  Object.defineProperty(fn, "end", { value: () => Promise.resolve() });
  return fn;
}

let cached: Db | undefined;

/**
 * Returns the process-wide DB client, creating it on first use.
 * No-op when DATABASE_URL is unset.
 */
export function getDb(): Db {
  if (cached) return cached;

  const url = Deno.env.get("DATABASE_URL");
  if (!url) {
    cached = makeNoop();
    return cached;
  }

  cached = postgres(url, {
    // Neon's pooled endpoint requires TLS; postgres.js negotiates it from the
    // sslmode in the connection string, but default to require for safety.
    ssl: "require",
    // Keep the per-isolate pool small — Deno Deploy spins up many isolates and
    // the pooled endpoint multiplexes for us.
    max: 5,
    // We connect through Neon's pooled (-pooler) endpoint in both local dev and
    // prod. That pooler is PgBouncer in transaction-pooling mode, which is
    // incompatible with postgres.js's default named prepared statements (causes
    // intermittent `prepared statement already exists`). Disable them.
    prepare: false,
  });
  return cached;
}

/** True when a real database is configured (not the no-op client). */
export function dbEnabled(): boolean {
  return Deno.env.get("DATABASE_URL") !== undefined;
}

/** Closes the cached connection (for graceful shutdown / test teardown). */
export async function closeDb(): Promise<void> {
  if (!cached) return;
  await cached.end();
  cached = undefined;
}
