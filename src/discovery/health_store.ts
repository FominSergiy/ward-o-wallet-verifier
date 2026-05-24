// Persisted per-service health stats. Updated by invokeAll after each call
// and consumed by rankServices to demote unreliable catalog entries.
//
// Storage: a single JSON file at data/service_health.json (gitignored) for
// local dev. On Deno Deploy the filesystem is read-only, so we fall back to
// an in-memory Map that resets on cold start — acceptable for hackathon
// scale. Detect Deploy via the DENO_DEPLOYMENT_ID env var, which Deploy
// sets automatically.

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

const DEFAULT_PATH = "data/service_health.json";
const ENABLED = Deno.env.get("HEALTH_TRACKING") !== "false";

const memoryStore = new Map<string, ServiceHealth>();

function isDeploy(): boolean {
  return Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;
}

function pathFor(): string {
  return Deno.env.get("HEALTH_STORE_PATH") ?? DEFAULT_PATH;
}

function ensureDir(filePath: string) {
  const slash = filePath.lastIndexOf("/");
  if (slash <= 0) return;
  const dir = filePath.slice(0, slash);
  try {
    Deno.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore — likely already exists
  }
}

export function readHealth(): HealthRecord {
  if (!ENABLED) return {};
  if (isDeploy()) return Object.fromEntries(memoryStore);
  try {
    const text = Deno.readTextFileSync(pathFor());
    return JSON.parse(text) as HealthRecord;
  } catch {
    return {};
  }
}

function writeHealth(record: HealthRecord): void {
  if (!ENABLED) return;
  if (isDeploy()) {
    memoryStore.clear();
    for (const [k, v] of Object.entries(record)) memoryStore.set(k, v);
    return;
  }
  const p = pathFor();
  ensureDir(p);
  try {
    Deno.writeTextFileSync(p, JSON.stringify(record, null, 2));
  } catch (e) {
    console.warn(`[health-store] failed to write ${p}: ${(e as Error).message}`);
  }
}

export function recordOk(resource: string): void {
  if (!ENABLED) return;
  const all = readHealth();
  const cur = all[resource] ?? { ok: 0, err: 0, lastSeen: "" };
  all[resource] = {
    ...cur,
    ok: cur.ok + 1,
    lastSeen: new Date().toISOString(),
  };
  writeHealth(all);
}

export function recordError(
  resource: string,
  msg: string,
  code?: string,
): void {
  if (!ENABLED) return;
  const all = readHealth();
  const cur = all[resource] ?? { ok: 0, err: 0, lastSeen: "" };
  all[resource] = {
    ...cur,
    err: cur.err + 1,
    lastSeen: new Date().toISOString(),
    lastError: msg.slice(0, 200),
    lastErrorCode: code,
  };
  writeHealth(all);
}

/**
 * Returns true if a resource has previously failed with an error code that
 * signals a durable config mismatch (e.g. catalog-vs-runtime price drift on
 * an x402 upstream). Used by the ranker to skip services that consistently
 * cannot be paid for under their advertised price.
 */
export function isDurablyBlocked(resource: string): boolean {
  const stats = readHealth()[resource];
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

export function recordEmptyOnRich(resource: string): void {
  if (!ENABLED) return;
  const all = readHealth();
  const cur = all[resource] ?? { ok: 0, err: 0, lastSeen: "" };
  all[resource] = {
    ...cur,
    emptyOnRich: (cur.emptyOnRich ?? 0) + 1,
    emptyOnRichAt: new Date().toISOString(),
  };
  writeHealth(all);
}

export function resetEmptyOnRich(resource: string): void {
  if (!ENABLED) return;
  const all = readHealth();
  const cur = all[resource];
  if (!cur || !cur.emptyOnRich) return;
  all[resource] = { ...cur, emptyOnRich: 0 };
  writeHealth(all);
}

/**
 * Returns true if a labeler has accumulated ≥ QUALITY_DEMOTION_THRESHOLD
 * empty-on-rich-history misses within the last QUALITY_DEMOTION_TTL_MS, and
 * thus should be deprioritized in subsequent ranking runs. After the TTL
 * window passes the demotion lifts automatically — provider coverage can
 * improve and we want to give updated catalogs a fresh shot.
 */
export function isQualityDemoted(resource: string): boolean {
  const stats = readHealth()[resource];
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
export function failureRate(resource: string): number | null {
  const stats = readHealth()[resource];
  if (!stats) return null;
  const total = stats.ok + stats.err;
  if (total === 0) return null;
  return stats.err / total;
}

/** Test-only helper to reset state between cases. */
export function _resetHealthStoreForTests(): void {
  memoryStore.clear();
  try {
    Deno.removeSync(pathFor());
  } catch {
    // file doesn't exist — fine
  }
}
