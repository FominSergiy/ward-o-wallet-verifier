// Persisted per-service health stats. Updated by invokeAll after each call
// and consumed by rankServices to demote unreliable catalog entries.
//
// Storage: Postgres `service_health_durable` table (W0.3). When DATABASE_URL
// is unset (offline / unit-test mode) the module falls back to an in-memory
// Map so `deno task test` stays fully offline-safe.

import { dbEnabled, getDb } from "../db/client.ts";

export interface ServiceHealth {
  ok: number;
  err: number;
  lastSeen: string;
  lastError?: string;
  lastErrorCode?: string;
  // Number of consecutive calls where the service returned a payload with no
  // recognizable entity attribution against a wallet that the rest of the
  // signal said was well-known (rich on-chain history). Reset to 0 on the
  // next non-empty response. Used to durably demote labelers whose coverage
  // is provably weak — see invoke_all.ts for the detection logic and rank.ts
  // for the demotion application.
  emptyOnRich?: number;
  emptyOnRichAt?: string;
}

// Error codes that signal a durable, service-specific failure mode (not a
// transient hiccup or a global state). A service flagged with one of these
// is skipped by the ranker on subsequent runs until the health store is
// explicitly reset. One-strike block — these codes only ever come from
// malformed catalog entries (e.g. literal `:endpoint` placeholders,
// descriptor-only roots with no usable action, HTML error pages from a
// non-x402 upstream), so retrying is wasted spend.
const DURABLE_BLOCK_CODES = new Set([
  "payment_exceeds_max",
  "not_found",
  "unsubstituted_path_param",
  "descriptor_only_response",
  "non_json_response",
]);

export type HealthRecord = Record<string, ServiceHealth>;

const ENABLED = Deno.env.get("HEALTH_TRACKING") !== "false";

// In-memory fallback (used when DATABASE_URL is unset).
const memoryStore = new Map<string, ServiceHealth>();

// ---------------------------------------------------------------------------
// Internal helpers — DB path
// ---------------------------------------------------------------------------

/** Read one row from Postgres; returns undefined if not found. */
async function dbGet(resource: string): Promise<ServiceHealth | undefined> {
  const db = getDb();
  const rows = await db`
    SELECT ok, err, last_seen, last_error, last_error_code,
           empty_on_rich, empty_on_rich_at
    FROM service_health_durable
    WHERE resource = ${resource}
  `;
  if (rows.length === 0) return undefined;
  const r = rows[0] as Record<string, unknown>;
  return {
    ok: r.ok as number,
    err: r.err as number,
    lastSeen: r.last_seen ? String(r.last_seen) : "",
    lastError: r.last_error ? String(r.last_error) : undefined,
    lastErrorCode: r.last_error_code ? String(r.last_error_code) : undefined,
    emptyOnRich: r.empty_on_rich as number | undefined,
    emptyOnRichAt: r.empty_on_rich_at ? String(r.empty_on_rich_at) : undefined,
  };
}

/** Upsert a row in Postgres. */
async function dbSet(resource: string, h: ServiceHealth): Promise<void> {
  const db = getDb();
  await db`
    INSERT INTO service_health_durable
      (resource, ok, err, last_seen, last_error, last_error_code,
       empty_on_rich, empty_on_rich_at)
    VALUES (
      ${resource},
      ${h.ok},
      ${h.err},
      ${h.lastSeen ? new Date(h.lastSeen) : null},
      ${h.lastError ?? null},
      ${h.lastErrorCode ?? null},
      ${h.emptyOnRich ?? 0},
      ${h.emptyOnRichAt ? new Date(h.emptyOnRichAt) : null}
    )
    ON CONFLICT (resource) DO UPDATE SET
      ok               = EXCLUDED.ok,
      err              = EXCLUDED.err,
      last_seen        = EXCLUDED.last_seen,
      last_error       = EXCLUDED.last_error,
      last_error_code  = EXCLUDED.last_error_code,
      empty_on_rich    = EXCLUDED.empty_on_rich,
      empty_on_rich_at = EXCLUDED.empty_on_rich_at
  `;
}

// ---------------------------------------------------------------------------
// Public API — all async
// ---------------------------------------------------------------------------

export async function readHealth(): Promise<HealthRecord> {
  if (!ENABLED) return {};
  if (dbEnabled()) {
    const db = getDb();
    const rows = await db`
      SELECT resource, ok, err, last_seen, last_error, last_error_code,
             empty_on_rich, empty_on_rich_at
      FROM service_health_durable
    `;
    const out: HealthRecord = {};
    for (const r of rows as Record<string, unknown>[]) {
      out[String(r.resource)] = {
        ok: r.ok as number,
        err: r.err as number,
        lastSeen: r.last_seen ? String(r.last_seen) : "",
        lastError: r.last_error ? String(r.last_error) : undefined,
        lastErrorCode: r.last_error_code
          ? String(r.last_error_code)
          : undefined,
        emptyOnRich: r.empty_on_rich as number | undefined,
        emptyOnRichAt: r.empty_on_rich_at
          ? String(r.empty_on_rich_at)
          : undefined,
      };
    }
    return out;
  }
  return Object.fromEntries(memoryStore);
}

export async function recordOk(resource: string): Promise<void> {
  if (!ENABLED) return;
  if (dbEnabled()) {
    const cur = (await dbGet(resource)) ?? { ok: 0, err: 0, lastSeen: "" };
    await dbSet(resource, {
      ...cur,
      ok: cur.ok + 1,
      lastSeen: new Date().toISOString(),
    });
  } else {
    const cur = memoryStore.get(resource) ?? { ok: 0, err: 0, lastSeen: "" };
    memoryStore.set(resource, {
      ...cur,
      ok: cur.ok + 1,
      lastSeen: new Date().toISOString(),
    });
  }
}

export async function recordError(
  resource: string,
  msg: string,
  code?: string,
): Promise<void> {
  if (!ENABLED) return;
  if (dbEnabled()) {
    const cur = (await dbGet(resource)) ?? { ok: 0, err: 0, lastSeen: "" };
    await dbSet(resource, {
      ...cur,
      err: cur.err + 1,
      lastSeen: new Date().toISOString(),
      lastError: msg.slice(0, 200),
      lastErrorCode: code,
    });
  } else {
    const cur = memoryStore.get(resource) ?? { ok: 0, err: 0, lastSeen: "" };
    memoryStore.set(resource, {
      ...cur,
      err: cur.err + 1,
      lastSeen: new Date().toISOString(),
      lastError: msg.slice(0, 200),
      lastErrorCode: code,
    });
  }
}

/**
 * Returns true if a resource has previously failed with an error code that
 * signals a durable config mismatch (e.g. catalog-vs-runtime price drift on
 * an x402 upstream). Used by the ranker to skip services that consistently
 * cannot be paid for under their advertised price.
 */
export async function isDurablyBlocked(resource: string): Promise<boolean> {
  let stats: ServiceHealth | undefined;
  if (dbEnabled()) {
    stats = await dbGet(resource);
  } else {
    stats = memoryStore.get(resource);
  }
  if (!stats?.lastErrorCode) return false;
  return DURABLE_BLOCK_CODES.has(stats.lastErrorCode);
}

// A labeler that returns empty payloads for ≥ this many rich-history wallets
// in a row is considered to have provably weak coverage and gets durably
// demoted in the next rerank. Threshold tuned to allow some genuine misses
// (a brand-new but rich-on-paper wallet might legitimately be unlabeled).
const QUALITY_DEMOTION_THRESHOLD = 3;
// Demotion expires after this many ms (7 days). After the window, the service
// gets a fresh chance — provider coverage may improve over time.
const QUALITY_DEMOTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function recordEmptyOnRich(resource: string): Promise<void> {
  if (!ENABLED) return;
  if (dbEnabled()) {
    const cur = (await dbGet(resource)) ?? { ok: 0, err: 0, lastSeen: "" };
    await dbSet(resource, {
      ...cur,
      emptyOnRich: (cur.emptyOnRich ?? 0) + 1,
      emptyOnRichAt: new Date().toISOString(),
    });
  } else {
    const cur = memoryStore.get(resource) ?? { ok: 0, err: 0, lastSeen: "" };
    memoryStore.set(resource, {
      ...cur,
      emptyOnRich: (cur.emptyOnRich ?? 0) + 1,
      emptyOnRichAt: new Date().toISOString(),
    });
  }
}

export async function resetEmptyOnRich(resource: string): Promise<void> {
  if (!ENABLED) return;
  if (dbEnabled()) {
    const cur = await dbGet(resource);
    if (!cur || !cur.emptyOnRich) return;
    await dbSet(resource, { ...cur, emptyOnRich: 0 });
  } else {
    const cur = memoryStore.get(resource);
    if (!cur || !cur.emptyOnRich) return;
    memoryStore.set(resource, { ...cur, emptyOnRich: 0 });
  }
}

/**
 * Returns true if a labeler has accumulated ≥ QUALITY_DEMOTION_THRESHOLD
 * empty-on-rich-history misses within the last QUALITY_DEMOTION_TTL_MS, and
 * thus should be deprioritized in subsequent ranking runs. After the TTL
 * window passes the demotion lifts automatically — provider coverage can
 * improve and we want to give updated catalogs a fresh shot.
 */
export async function isQualityDemoted(resource: string): Promise<boolean> {
  let stats: ServiceHealth | undefined;
  if (dbEnabled()) {
    stats = await dbGet(resource);
  } else {
    stats = memoryStore.get(resource);
  }
  if (!stats?.emptyOnRich || !stats.emptyOnRichAt) return false;
  if (stats.emptyOnRich < QUALITY_DEMOTION_THRESHOLD) return false;
  const ageMs = Date.now() - Date.parse(stats.emptyOnRichAt);
  if (Number.isNaN(ageMs) || ageMs > QUALITY_DEMOTION_TTL_MS) return false;
  return true;
}

/**
 * Returns the failure rate (err / (ok + err)) for a resource, or null if no
 * data has been recorded. Use null to signal "untested" to the ranker — it
 * shouldn't bias against unknown services.
 */
export async function failureRate(resource: string): Promise<number | null> {
  let stats: ServiceHealth | undefined;
  if (dbEnabled()) {
    stats = await dbGet(resource);
  } else {
    stats = memoryStore.get(resource);
  }
  if (!stats) return null;
  const total = stats.ok + stats.err;
  if (total === 0) return null;
  return stats.err / total;
}

/**
 * Test-only helper to reset state between cases.
 * Clears the in-memory map and, when DB is enabled, deletes all rows from
 * service_health_durable.
 */
export async function _resetHealthStoreForTests(): Promise<void> {
  memoryStore.clear();
  if (dbEnabled()) {
    const db = getDb();
    await db`DELETE FROM service_health_durable`;
  }
}
