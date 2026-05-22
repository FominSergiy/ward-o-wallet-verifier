// Persisted per-service health stats. Updated by invokeAll after each call
// and consumed by rankServices to demote unreliable catalog entries.
//
// Storage: a single JSON file at data/service_health.json (gitignored).
// Reads on every access (fast for typical sizes — sub-1KB after a few runs).
// Writes after every record* call. Acceptable race-conditions for hackathon
// single-process throughput; a real production deployment would back this
// with Deno KV or a sqlite store.

export interface ServiceHealth {
  ok: number;
  err: number;
  lastSeen: string;
  lastError?: string;
}

export type HealthRecord = Record<string, ServiceHealth>;

const DEFAULT_PATH = "data/service_health.json";
const ENABLED = Deno.env.get("HEALTH_TRACKING") !== "false";

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
  try {
    const text = Deno.readTextFileSync(pathFor());
    return JSON.parse(text) as HealthRecord;
  } catch {
    return {};
  }
}

function writeHealth(record: HealthRecord): void {
  if (!ENABLED) return;
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
    ok: cur.ok + 1,
    err: cur.err,
    lastSeen: new Date().toISOString(),
  };
  writeHealth(all);
}

export function recordError(resource: string, msg: string): void {
  if (!ENABLED) return;
  const all = readHealth();
  const cur = all[resource] ?? { ok: 0, err: 0, lastSeen: "" };
  all[resource] = {
    ok: cur.ok,
    err: cur.err + 1,
    lastSeen: new Date().toISOString(),
    lastError: msg.slice(0, 200),
  };
  writeHealth(all);
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
  try {
    Deno.removeSync(pathFor());
  } catch {
    // file doesn't exist — fine
  }
}
