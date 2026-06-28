import { getDb } from "../db/client.ts";

// ── Scoring weights ───────────────────────────────────────────────────────────
// Must sum to 1.0.
const W_RELIABILITY = 0.6;
const W_LATENCY = 0.25;
const W_COVERAGE = 0.15;

// P95 latency at or above this ceiling contributes 0 to the latency component.
const LATENCY_CEILING_MS = 30_000;

// ── Status-transition thresholds ─────────────────────────────────────────────
// active → probation when reliability drops below this
const DEMOTION_THRESHOLD = 0.5;
// probation → active after window with reliability at or above this
const PROMOTION_THRESHOLD = 0.8;
// probation → blocked when reliability falls below this (persistent failure)
const BLOCK_THRESHOLD = 0.2;

// ── Types ────────────────────────────────────────────────────────────────────

export interface WindowMetrics {
  resource: string;
  total: number;
  successes: number;
  p95LatencyMs: number | null;
  emptyOnRich: number;
}

interface RegistrySummary {
  resource: string;
  status: string;
  score: string;
}

export interface RecomputeResult {
  updated: number;
  transitions: Array<{ resource: string; from: string; to: string }>;
}

export interface RecomputeOpts {
  // Test seams — defaults hit the DB.
  fetchMetrics?: () => Promise<WindowMetrics[]>;
  fetchRegistry?: (resources: string[]) => Promise<RegistrySummary[]>;
  applyUpdate?: (
    resource: string,
    score: number,
    status: string,
  ) => Promise<void>;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Computes a 0–1 score from a 30-day window of observations. */
export function computeScore(m: WindowMetrics): number {
  if (m.total === 0) return 1.0;
  const reliability = m.successes / m.total;
  const latencyScore = m.p95LatencyMs == null
    ? 1.0
    : Math.max(0, 1 - m.p95LatencyMs / LATENCY_CEILING_MS);
  const coverageRate = 1 - m.emptyOnRich / m.total;
  return (
    W_RELIABILITY * reliability +
    W_LATENCY * latencyScore +
    W_COVERAGE * coverageRate
  );
}

/**
 * Determines the next status for a service given its current status and the
 * reliability observed in the trailing window.
 *
 * Invariant: `blocked` can only be lifted via an explicit operator retry — this
 * function never transitions away from `blocked`.
 */
export function nextStatus(
  current: string,
  reliability: number,
  total: number,
): string {
  if (current === "blocked") return "blocked";
  if (total === 0) return current;

  if (current === "active") {
    return reliability < DEMOTION_THRESHOLD ? "probation" : "active";
  }
  if (current === "probation") {
    if (reliability >= PROMOTION_THRESHOLD) return "active";
    if (reliability < BLOCK_THRESHOLD) return "blocked";
    return "probation";
  }
  return current;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function defaultFetchMetrics(): Promise<WindowMetrics[]> {
  const db = getDb();
  const rows = await db<
    Array<{
      resource: string;
      total: string;
      successes: string;
      p95_latency_ms: string | null;
      empty_on_rich: string;
    }>
  >`
    SELECT
      resource,
      COUNT(*)::text                                                        AS total,
      -- service_observations records successes as 'ok' (covers both the
      -- pattern-adapter "ok" and LLM-fallback "fallback_ok" outcomes; see
      -- invoke_all.ts). The previous 'success' literal matched nothing, so EVERY
      -- service computed 0 reliability and got demoted active→probation→blocked
      -- — the real driver of the W0.11 "0 active services" deadlock.
      COUNT(*) FILTER (WHERE status = 'ok')::text                          AS successes,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::text      AS p95_latency_ms,
      COALESCE(SUM(CASE WHEN empty_on_rich THEN 1 ELSE 0 END), 0)::text   AS empty_on_rich
    FROM service_observations
    WHERE created_at >= now() - INTERVAL '30 days'
    GROUP BY resource
  `;
  return rows.map((r) => ({
    resource: r.resource,
    total: parseInt(r.total),
    successes: parseInt(r.successes),
    p95LatencyMs: r.p95_latency_ms != null
      ? parseFloat(r.p95_latency_ms)
      : null,
    emptyOnRich: parseInt(r.empty_on_rich),
  }));
}

async function defaultFetchRegistry(
  resources: string[],
): Promise<RegistrySummary[]> {
  const db = getDb();
  return await db<RegistrySummary[]>`
    SELECT resource, status, score::text AS score
    FROM service_registry
    WHERE resource = ANY(${resources})
  `;
}

async function defaultApplyUpdate(
  resource: string,
  score: number,
  status: string,
): Promise<void> {
  const db = getDb();
  await db`
    UPDATE service_registry
    SET score = ${score.toFixed(4)},
        status = ${status},
        updated_at = now()
    WHERE resource = ${resource}
  `;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Reads the trailing-30-day service_observations, computes a reliability/
 * latency/coverage score for each service, and writes the updated score and
 * status back to service_registry.
 *
 * Status transitions driven by the trailing window:
 *   active    → probation  when reliability < 0.50
 *   probation → active     when reliability ≥ 0.80
 *   probation → blocked    when reliability < 0.20 (persistent failure)
 *   blocked   → (unchanged — operator must explicitly retry to lift)
 */
export async function recomputeScores(
  opts: RecomputeOpts = {},
): Promise<RecomputeResult> {
  const fetchMetrics = opts.fetchMetrics ?? defaultFetchMetrics;
  const fetchRegistry = opts.fetchRegistry ?? defaultFetchRegistry;
  const applyUpdate = opts.applyUpdate ?? defaultApplyUpdate;

  const metrics = await fetchMetrics();
  if (metrics.length === 0) return { updated: 0, transitions: [] };

  const resources = metrics.map((m) => m.resource);
  const registryRows = await fetchRegistry(resources);
  const registryByResource = new Map(registryRows.map((r) => [r.resource, r]));

  const transitions: Array<{ resource: string; from: string; to: string }> = [];
  let updated = 0;

  for (const m of metrics) {
    const reg = registryByResource.get(m.resource);
    if (!reg) continue;

    const reliability = m.total > 0 ? m.successes / m.total : 1;
    const score = computeScore(m);
    const newStatus = nextStatus(reg.status, reliability, m.total);

    const oldScore = parseFloat(reg.score);
    const scoreChanged = Math.abs(oldScore - score) >= 0.00005;
    const statusChanged = newStatus !== reg.status;
    if (!scoreChanged && !statusChanged) continue;

    await applyUpdate(m.resource, score, newStatus);
    if (statusChanged) {
      transitions.push({
        resource: m.resource,
        from: reg.status,
        to: newStatus,
      });
    }
    updated++;
  }

  return { updated, transitions };
}
