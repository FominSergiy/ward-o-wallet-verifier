import { getDb } from "../db/client.ts";
import { ObservationStatus, ServiceStatus } from "../db/enums.ts";

// ── Scoring weights ───────────────────────────────────────────────────────────
// Must sum to 1.0.
const W_RELIABILITY = 0.6;
const W_LATENCY = 0.25;
const W_COVERAGE = 0.15;

// P95 latency at or above this ceiling contributes 0 to the latency component.
const LATENCY_CEILING_MS = 30_000;

// ── Reliability smoothing (pessimistic Bayesian prior) ───────────────────────
// A freshly discovered service used to score 1.0 with ZERO observations
// (total===0 → 1.0), so an untested — often dead — probation candidate tied or
// outranked a proven one and won the primary slot on the hot path. We instead
// smooth reliability toward a pessimistic prior: PRIOR_SUCCESSES "virtual"
// successes out of PRIOR_TOTAL "virtual" observations. A zero-observation
// service therefore starts at PRIOR_SUCCESSES/PRIOR_TOTAL (0.25), well below any
// service that has actually demonstrated success, and must earn its way up.
const PRIOR_SUCCESSES = 1;
const PRIOR_TOTAL = 4;

// ── Status-transition thresholds ─────────────────────────────────────────────
// active → probation when reliability drops below this
const DEMOTION_THRESHOLD = 0.5;
// probation → active after window with reliability at or above this
const PROMOTION_THRESHOLD = 0.8;
// probation → blocked when reliability falls below this (persistent failure)
const BLOCK_THRESHOLD = 0.2;
// Don't permanently block on a tiny sample — a single early failure shouldn't
// hard-block a service forever (blocked is only lifted by an operator). True
// structural deadness (non-x402 endpoints, 404s) is caught immediately and
// independently by the registry persist-block in the invocation path; this
// scoring-driven block is the slower reliability backstop.
const MIN_BLOCK_OBSERVATIONS = 3;

// ── Types ────────────────────────────────────────────────────────────────────

export interface WindowMetrics {
  resource: string;
  total: number;
  successes: number;
  p95LatencyMs: number | null;
  emptyOnRich: number;
  // Observations excluded from the reliability denominator because they reflect
  // a payer-side / config condition (our max-value cap, insufficient balance, no
  // wallet) rather than the upstream being down. Counting these as failures used
  // to permanently block genuinely-working services (e.g. a 53%-ok labeler whose
  // price drifted above our cap). Defaults to 0 for callers/tests that omit it.
  excluded?: number;
}

/** Observations counted toward reliability (total minus payer-side excludes). */
function effectiveTotal(m: WindowMetrics): number {
  return Math.max(0, m.total - (m.excluded ?? 0));
}

/**
 * Smoothed reliability in [0,1]: observed successes blended with a pessimistic
 * prior so low-sample services can't sit at a perfect score. Excludes
 * payer-side/config observations from the denominator.
 */
export function smoothedReliability(m: WindowMetrics): number {
  const eff = effectiveTotal(m);
  return (m.successes + PRIOR_SUCCESSES) / (eff + PRIOR_TOTAL);
}

interface RegistrySummary {
  resource: string;
  status: ServiceStatus;
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
    status: ServiceStatus,
  ) => Promise<void>;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Computes a 0–1 score from a 30-day window of observations. */
export function computeScore(m: WindowMetrics): number {
  const eff = effectiveTotal(m);
  const reliability = smoothedReliability(m);
  const latencyScore = m.p95LatencyMs == null
    ? 1.0
    : Math.max(0, 1 - m.p95LatencyMs / LATENCY_CEILING_MS);
  const coverageRate = eff > 0 ? 1 - m.emptyOnRich / eff : 1.0;
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
  current: ServiceStatus,
  reliability: number,
  total: number,
): ServiceStatus {
  if (current === ServiceStatus.BLOCKED) return ServiceStatus.BLOCKED;
  if (total === 0) return current;

  if (current === ServiceStatus.ACTIVE) {
    return reliability < DEMOTION_THRESHOLD
      ? ServiceStatus.PROBATION
      : ServiceStatus.ACTIVE;
  }
  if (current === ServiceStatus.PROBATION) {
    if (reliability >= PROMOTION_THRESHOLD) return ServiceStatus.ACTIVE;
    // Only hard-block once we've seen enough calls to trust the failure signal.
    if (reliability < BLOCK_THRESHOLD && total >= MIN_BLOCK_OBSERVATIONS) {
      return ServiceStatus.BLOCKED;
    }
    return ServiceStatus.PROBATION;
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
      excluded: string;
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
      COUNT(*) FILTER (WHERE status = ${ObservationStatus.OK})::text       AS successes,
      -- Payer-side / config failures (our max-value cap, insufficient balance,
      -- no wallet) are NOT the upstream being down — counting them as failures
      -- permanently blocked genuinely-working services. service_observations
      -- stores the full agnicFetch message in error_code, so match on substring.
      COUNT(*) FILTER (
        WHERE status = ${ObservationStatus.ERROR}
          AND (
            error_code ILIKE '%payment exceeds maximum%'
            OR error_code ILIKE '%insufficient%balance%'
            OR error_code ILIKE '%no wallet%'
            OR error_code ILIKE '%no_wallet%'
          )
      )::text                                                              AS excluded,
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
    excluded: parseInt(r.excluded),
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

    // Status transitions use the smoothed reliability (same value the score is
    // built from) over the effective sample — both exclude payer-side failures.
    const eff = Math.max(0, m.total - (m.excluded ?? 0));
    const reliability = smoothedReliability(m);
    const score = computeScore(m);
    const newStatus = nextStatus(reg.status, reliability, eff);

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
