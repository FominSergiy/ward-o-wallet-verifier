// ── Vetter probation-probe phase ──────────────────────────────────────────────
//
// Root problem this solves: a service in `probation` is only ever the *cold
// fallback* tier on the hot path (selection makes the top-ranked service the
// primary and invokes probation rows only when the primary fails). Healthy
// primaries rarely fail, so probation candidates receive ~zero organic traffic
// and can never accumulate the ~11 successful observations that
// registry/score.ts requires to promote them (reliability ≥ 0.80 under the
// pessimistic 1/4 prior). With ~0 real traffic the registry can only ever shrink
// toward its seed services.
//
// This phase supplies the missing evidence WITHOUT lowering the promotion bar:
// it pays-and-invokes probation candidates against the wallet fixtures, exactly
// like a real /invoke would, so each call records a real service_observation.
// The vetter's existing recomputeScores() step then promotes (≥0.80) or blocks
// (<0.20) them as designed.
//
// Because this spends real USDC, it is bounded by two independent guards:
//   • a per-run spend CEILING (budgetUsdc) — the loop never STARTS a candidate
//     whose predicted probe cost would push cumulative spend over the ceiling;
//   • a balance FLOOR (minBalanceUsdc) — the whole phase is skipped when the
//     Agnic balance is below a reserve, so it only spends from surplus.
// The caller (runVetter) additionally gates the phase on budgetUsdc > 0, so it
// is a no-op unless explicitly funded.

import type { Chain } from "../agent/types.ts";
import { invokeAll, SanctionsInvocationError } from "../agent/invoke_all.ts";
import type { DiscoveryPlan, RankedService } from "../discovery/types.ts";
import { getActiveServices, rowToRanked } from "../registry/read.ts";
import type { RegistryEntry } from "../registry/types.ts";
import { ServiceStatus } from "../db/enums.ts";
import { getDeniedHosts, isDeniedHost } from "../discovery/host_denylist.ts";
import { fetchAgnicBudget } from "../discovery/network.ts";
import { runWithRequestContext } from "../observability/request_context.ts";
import { WALLET_FIXTURES } from "../fixtures/wallets.ts";
import { log } from "../observability/log.ts";

// Fixtures are Ethereum-mainnet addresses; probe on the same default chain the
// verify pipeline uses for a bare address (see verify.ts DEFAULT_CHAIN).
const PROBE_CHAIN: Chain = "eth";

export interface ProbeOpts {
  /** Per-run spend ceiling in USDC. The loop stops before exceeding it. */
  budgetUsdc: number;
  /** Skip the whole phase if the Agnic balance is below this floor. 0 = off. */
  minBalanceUsdc: number;
  /** Skip any candidate priced above this. Defaults to 0.10. */
  maxPriceUsdc?: number;
  /** How many fixtures to probe per candidate this run. Defaults to 3. */
  fixtureCount?: number;

  // ── Seams (tests inject fakes; all default to the real thing) ──────────────
  /** Probation candidates, richest call-shape first. Default: DB read. */
  fetchProbation?: () => Promise<RegistryEntry[]>;
  /** Current Agnic USDC balance, or null if undeterminable. */
  fetchBalance?: () => Promise<number | null>;
  /** Invoke one single-service plan. Default: real invokeAll. */
  invoke?: (
    plan: DiscoveryPlan,
    chain: Chain,
    opts: { disableViemFallback?: boolean; request_id?: string },
  ) => Promise<{ totalSpentUsdc: number }>;
  /** Fixture wallets to probe against. Default: WALLET_FIXTURES. */
  fixtures?: Array<{ address: string }>;
}

export interface ProbeResult {
  /** Distinct probation candidates that received at least one probe. */
  probed: number;
  /** Candidates skipped (price cap, denied host, or budget exhausted). */
  skipped: number;
  /** Total USDC actually spent across all probe calls this run. */
  spendUsdc: number;
  /** True when the phase was skipped wholesale because balance < floor. */
  belowFloor: boolean;
  /** Total service_observations recorded (one per fixture invocation). */
  observations: number;
}

/** Default: read probation rows via the shared registry read path. */
async function defaultFetchProbation(): Promise<RegistryEntry[]> {
  // getActiveServices() returns active + probation with full call-shape columns;
  // keep only probation — active rows already earn organic traffic.
  const all = await getActiveServices();
  return all.filter((e) => e.status === ServiceStatus.PROBATION);
}

/** Default: the same balance signal the /verify-agent pre-flight guard uses. */
async function defaultFetchBalance(): Promise<number | null> {
  const budget = await fetchAgnicBudget();
  return budget?.totalBalance ?? null;
}

/** Build a minimal one-service plan the invocation phase can drive. */
function singleServicePlan(
  svc: RankedService,
  address: string,
): DiscoveryPlan {
  return {
    address,
    walletNetwork: "base",
    services: [svc],
    alternates: {},
    totalEstimatedCostUsdc: svc.priceUsdc,
    unresolvedCategories: [],
    deterministicSources: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Pay-and-invoke probation candidates against the fixtures to accrue real
 * observations. Cheapest + least-recently-vetted first; bounded by the spend
 * ceiling and balance floor. Never throws — a per-candidate failure (including
 * the sanctions fail-fast) is caught, its observation is already recorded, and
 * the loop moves on.
 */
export async function probeProbationCandidates(
  opts: ProbeOpts,
): Promise<ProbeResult> {
  const maxPrice = opts.maxPriceUsdc ?? 0.10;
  const fixtureCount = opts.fixtureCount ?? 3;
  const fetchProbation = opts.fetchProbation ?? defaultFetchProbation;
  const fetchBalance = opts.fetchBalance ?? defaultFetchBalance;
  const invoke = opts.invoke ??
    ((plan, chain, o) => invokeAll(plan, chain, o));
  const fixtures = (opts.fixtures ?? WALLET_FIXTURES).slice(0, fixtureCount);

  const empty: ProbeResult = {
    probed: 0,
    skipped: 0,
    spendUsdc: 0,
    belowFloor: false,
    observations: 0,
  };

  if (opts.budgetUsdc <= 0) return empty;
  if (fixtures.length === 0) return empty;

  // ── Balance floor ──────────────────────────────────────────────────────────
  if (opts.minBalanceUsdc > 0) {
    const balance = await fetchBalance();
    if (balance !== null && balance < opts.minBalanceUsdc) {
      log.warn(
        `[vetter] probe skipped — balance $${balance.toFixed(4)} < floor $${
          opts.minBalanceUsdc.toFixed(2)
        }`,
      );
      return { ...empty, belowFloor: true };
    }
    if (balance === null) {
      // Mirror the /verify-agent guard: undeterminable balance proceeds (the
      // per-run ceiling still bounds exposure) rather than stalling the phase.
      log.warn(
        "[vetter] probe: balance undeterminable — proceeding on ceiling",
      );
    }
  }

  // ── Candidate ordering: cheapest, then least-recently-vetted (nulls first) ──
  const deniedHosts = getDeniedHosts();
  const candidates = (await fetchProbation())
    .filter((e) => !isDeniedHost(e.resource, deniedHosts))
    .sort((a, b) => {
      if (a.price_usdc !== b.price_usdc) return a.price_usdc - b.price_usdc;
      const av = a.last_vetted_at ? a.last_vetted_at.getTime() : 0;
      const bv = b.last_vetted_at ? b.last_vetted_at.getTime() : 0;
      return av - bv;
    });

  let probed = 0;
  let skipped = 0;
  let spendUsdc = 0;
  let observations = 0;

  await runWithRequestContext(null, null, async () => {
    for (const entry of candidates) {
      if (entry.price_usdc > maxPrice) {
        skipped++;
        continue;
      }
      // Never START a candidate that could push spend over the ceiling. Gate on
      // the stored price (kept fresh by the price-probe phase that ran first).
      const predictedCost = entry.price_usdc * fixtures.length;
      if (spendUsdc + predictedCost > opts.budgetUsdc) {
        skipped++;
        continue;
      }

      const svc = rowToRanked(entry);
      let didProbe = false;
      for (const fx of fixtures) {
        const plan = singleServicePlan(svc, fx.address);
        try {
          const res = await invoke(plan, PROBE_CHAIN, {
            disableViemFallback: true,
            request_id: `vetter-probe-${crypto.randomUUID()}`,
          });
          spendUsdc += res.totalSpentUsdc;
        } catch (e) {
          // invokeAll fail-fasts on a sanctions error AFTER recording the
          // observation — so the evidence still lands; just count it and move
          // on. A failed call did not settle payment (spend unchanged).
          if (!(e instanceof SanctionsInvocationError)) {
            log.warn(
              `[vetter] probe ${entry.resource} errored: ${
                (e as Error).message
              }`,
            );
          }
        }
        observations++;
        didProbe = true;
      }
      if (didProbe) probed++;
    }
  });

  log.info(
    `[vetter] probe: ${probed} probed, ${skipped} skipped, ${observations} obs, $${
      spendUsdc.toFixed(6)
    } spent`,
  );
  return { probed, skipped, spendUsdc, belowFloor: false, observations };
}
