import type { VerifyRequest } from "./types.ts";
import { defaultLlm, type LlmClient, withCostTracking } from "./llm.ts";
import type { Category, Chain } from "./types.ts";
import { selectFromRegistry } from "../registry/select.ts";
import { invokeAll } from "./invoke_all.ts";
import { synthesizeVerdict } from "./synthesize_verdict.ts";
import type { WalletVerdict } from "./verdict.ts";
import type { DiscoveryPlan, WalletNetwork } from "../discovery/types.ts";
import type { ServiceInvocationOutcome } from "./invoke_service.ts";
import { type EventEmitter, now, safeEmit } from "./events.ts";
import {
  checkSanctionsOracle,
  ORACLE_SUPPORTED_CHAINS,
  type OracleResult,
} from "./sanctions_oracle.ts";
import { ensSupportedFor, resolveEns } from "./ens_resolver.ts";
import { fetchLabelsRegistry } from "./labels_registry.ts";
import { type VerdictCache } from "./verdict_cache.ts";
import {
  type DenylistEntry,
  type SanctionedDenylist,
} from "./sanctioned_denylist.ts";

// Two-tier depth selector. "deep" (default) runs the full pipeline:
// denylist + oracle → discovery → paid x402 fanout → LLM synthesis. "fast"
// runs only the free, sub-second sanctions gate (denylist + Chainalysis oracle)
// and returns a machine-readable signal WITHOUT any x402 spend, so an agent can
// act on a binding block/proceed in <1s and opt into the paid deep check only
// when needed.
export type VerifyDepth = "fast" | "deep";

// Agent-actionable fast-tier outcome. `block` = sanctioned (do_not_transact);
// `proceed` = a previously cached safe verdict; `needs_deep_check` = no blocking
// signal, but a full verdict requires the paid deep tier.
export type FastSignal = "block" | "proceed" | "needs_deep_check";

function fastSignalForVerdict(v: WalletVerdict["verdict"]): FastSignal {
  if (v === "do_not_transact") return "block";
  if (v === "safe_to_transact") return "proceed";
  return "needs_deep_check";
}

// The user submits a bare EVM address; we no longer ask them to pick a chain.
// Chain-sensitive downstream paths (x402 invocation, ENS, viem fallback) use
// this default — eth has the deepest label / coverage and produces the most
// useful signal when no chain context is supplied. The Chainalysis sanctions
// oracle is a separate story: it fans out across every supported EVM chain
// (see ORACLE_SUPPORTED_CHAINS) so a sanctioned address can't slip through
// just because one chain's oracle hasn't picked it up.
const DEFAULT_CHAIN: Chain = "eth";

const DEFAULT_CATEGORIES: Category[] = [
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
  "ens",
];

export interface VerifyAgentResult {
  verdict: WalletVerdict;
  plan: DiscoveryPlan;
  outcomes: ServiceInvocationOutcome[];
  walletNetwork: WalletNetwork;
  totalSpentUsdc: number;
  // Total USD spent on LLM/AI model calls for this run (synthesis + any
  // discovery rerank / descriptor-retry calls). Separate from totalSpentUsdc,
  // which is x402 paid-service spend only. Zero on cache hits and the
  // oracle-sanctioned short-circuit, since neither runs an LLM call.
  totalLlmCostUsd: number;
  // Populated when the Opus synthesis call failed; the verdict above is a
  // conservative stub ("insufficient_data" / safe=false). All paid receipts
  // are still preserved so the caller can render or re-synthesize manually.
  synthesisError?: string;
  // Which tier produced this result. "fast" results never incur x402 spend.
  tier?: VerifyDepth;
  // Agent-actionable signal derived from the verdict. Always set by verifyAgent.
  fastSignal?: FastSignal;
}

export interface VerifyAgentOpts {
  budgetCeiling?: number;
  llm?: LlmClient;
  categories?: Category[];
  onEvent?: EventEmitter;
  request_id?: string;
  verdictCache?: VerdictCache;
  // Long-TTL sanctions denylist (warmed by the vetter cron). Checked at the top
  // of the pipeline before the oracle fan-out; a hit short-circuits to a
  // deterministic do_not_transact with zero spend. Optional — a miss falls
  // through to the live oracle path, so correctness never depends on it.
  denylist?: SanctionedDenylist;
  // "fast" = free sanctions gate only (no x402 spend); "deep" (default) = full
  // pipeline. See VerifyDepth.
  depth?: VerifyDepth;
  // Injection seam for unit tests — replace any of the discovery-flow
  // collaborators. Real callers leave undefined and the default
  // implementations are used.
  _testHooks?: {
    selectFromRegistry?: typeof selectFromRegistry;
    invokeAll?: typeof invokeAll;
    synthesizeVerdict?: typeof synthesizeVerdict;
    checkSanctionsOracle?: typeof checkSanctionsOracle;
    resolveEns?: typeof resolveEns;
    fetchLabelsRegistry?: typeof fetchLabelsRegistry;
  };
}

function stubVerdict(
  req: VerifyRequest,
  categories: Category[],
  resolved: Category[],
  unresolved: Category[],
  notApplicable: Category[],
  totalSpentUsdc: number,
  errorMessage: string,
): WalletVerdict {
  return {
    address: req.address,
    chain: DEFAULT_CHAIN,
    safe: false,
    verdict: "insufficient_data",
    confidence: "low",
    headline: `Synthesis failed — manual review required: ${
      errorMessage.slice(0, 120)
    }`,
    reasoning:
      "The risk analysis step errored before producing a final verdict. " +
      "Raw service findings are available in the receipts for manual review. " +
      "Treat this verdict as a placeholder, NOT as a determination of safety.",
    findings: [],
    coverage: {
      requested: categories,
      resolved,
      unresolved,
      ...(notApplicable.length > 0 ? { not_applicable: notApplicable } : {}),
    },
    totalSpentUsdc,
    generatedAt: new Date().toISOString(),
  };
}

// CHAIN-PRIMITIVE FALLBACK: deterministic verdict produced when the on-chain
// Chainalysis sanctions oracle returns isSanctioned=true on ANY supported
// chain. We bypass discovery, x402 invocation and Opus synthesis entirely —
// the oracle is a definitive negative-truth signal and further spend would
// be wasted.
function oracleSanctionedVerdict(
  req: VerifyRequest,
  categories: Category[],
  notApplicable: Category[],
  oracle: OracleResult,
): WalletVerdict {
  return {
    address: req.address,
    chain: oracle.chain,
    safe: false,
    verdict: "do_not_transact",
    confidence: "high",
    headline:
      "Do not transact — address is flagged by the Chainalysis on-chain sanctions oracle.",
    reasoning:
      `The Chainalysis sanctions oracle (${oracle.oracleAddress}) returned ` +
      `isSanctioned=true for this address on ${oracle.chain}. This oracle is ` +
      `sourced from OFAC SDN and other government sanctions lists. The signal ` +
      `is deterministic and overrides all other evidence; downstream x402 ` +
      `service calls were skipped to avoid unnecessary spend.`,
    findings: [{
      category: "sanctions",
      severity: "critical",
      finding:
        `Chainalysis sanctions oracle returned isSanctioned=true at ${oracle.oracleAddress} on ${oracle.chain}.`,
    }],
    coverage: {
      requested: categories,
      resolved: ["sanctions"],
      unresolved: categories.filter((c) => c !== "sanctions"),
      ...(notApplicable.length > 0 ? { not_applicable: notApplicable } : {}),
    },
    totalSpentUsdc: 0,
    generatedAt: new Date().toISOString(),
  };
}

// DENYLIST FAST-PATH: deterministic verdict produced when the warmed sanctions
// denylist (OFAC SDN, warmed by the vetter cron) contains the address. Returned
// in <100ms from a single KV read, before the oracle fan-out — zero spend.
function denylistVerdict(
  req: VerifyRequest,
  categories: Category[],
  notApplicable: Category[],
  entry: DenylistEntry,
): WalletVerdict {
  return {
    address: req.address,
    chain: DEFAULT_CHAIN,
    safe: false,
    verdict: "do_not_transact",
    confidence: "high",
    headline: "Do not transact — address is on the sanctions denylist.",
    reasoning: `This address is present on the warmed sanctions denylist ` +
      `(reason: ${entry.reason}, source: ${entry.source}, warmed ${entry.warmedAt}). ` +
      `The denylist is built from the OFAC SDN list and is deterministic; ` +
      `downstream oracle and x402 service calls were skipped to avoid ` +
      `unnecessary latency and spend.`,
    findings: [{
      category: "sanctions",
      severity: "critical",
      finding: `Address present on sanctions denylist (${entry.reason}).`,
    }],
    coverage: {
      requested: categories,
      resolved: ["sanctions"],
      unresolved: categories.filter((c) => c !== "sanctions"),
      ...(notApplicable.length > 0 ? { not_applicable: notApplicable } : {}),
    },
    totalSpentUsdc: 0,
    generatedAt: new Date().toISOString(),
  };
}

// FAST-TIER INCONCLUSIVE: returned by the "fast" depth when the free sanctions
// gate (denylist + Chainalysis oracle) finds no blocking signal. It is NOT a
// safety determination — it tells the caller the paid deep check is needed.
// Zero spend.
function fastNeedsDeepVerdict(
  req: VerifyRequest,
  categories: Category[],
  notApplicable: Category[],
  oracleResult: OracleResult | null,
): WalletVerdict {
  const sanctionsResolved = oracleResult !== null;
  return {
    address: req.address,
    chain: DEFAULT_CHAIN,
    safe: false,
    verdict: "insufficient_data",
    confidence: "low",
    headline:
      "Fast check cleared the sanctions gate — run a deep check for a full risk verdict.",
    reasoning:
      "The fast tier (sanctions denylist + Chainalysis on-chain oracle) found " +
      "no blocking signal, but a final safe/unsafe determination requires the " +
      "paid deep analysis (labels, on-chain history, sentiment, synthesis). " +
      "No spend was incurred. Re-run with depth=deep for a final verdict.",
    findings: sanctionsResolved
      ? [{
        category: "sanctions",
        severity: "info",
        finding: "Chainalysis sanctions oracle returned isSanctioned=false.",
      }]
      : [],
    coverage: {
      requested: categories,
      resolved: sanctionsResolved ? ["sanctions"] : [],
      unresolved: categories.filter((c) =>
        !sanctionsResolved || c !== "sanctions"
      ),
      ...(notApplicable.length > 0 ? { not_applicable: notApplicable } : {}),
    },
    totalSpentUsdc: 0,
    generatedAt: new Date().toISOString(),
  };
}

interface ChainOracleAttempt {
  chain: Chain;
  result?: OracleResult;
  error?: string;
}

// Fan the Chainalysis oracle across every supported EVM chain in parallel.
// Chainalysis maintains a separate oracle deployment per chain — an OFAC-
// listed address flagged on eth's oracle is not necessarily flagged on base's
// oracle. The strictest signal (any isSanctioned=true) wins. Emits one
// service event per chain so the UI can render the fan-out.
async function checkOracleAcrossChains(
  address: string,
  oracleCheckFn: typeof checkSanctionsOracle,
  emit: EventEmitter | undefined,
  request_id: string,
): Promise<ChainOracleAttempt[]> {
  const attempts = await Promise.all(
    ORACLE_SUPPORTED_CHAINS.map(async (chain): Promise<ChainOracleAttempt> => {
      const resource = `chainalysis_oracle://${chain}`;
      const start = Date.now();
      safeEmit(emit, {
        type: "service",
        status: "start",
        category: "sanctions",
        resource,
        kind: "direct",
        priceUsdc: 0,
        request_id,
        duration_ms: 0,
        cost_usd: null,
        at: now(),
      });
      try {
        const result = await oracleCheckFn(address, chain);
        safeEmit(emit, {
          type: "service",
          status: "ok",
          category: "sanctions",
          resource,
          kind: "direct",
          priceUsdc: 0,
          amountUsdc: 0,
          request_id,
          duration_ms: Date.now() - start,
          cost_usd: null,
          at: now(),
        });
        safeEmit(emit, {
          type: "log",
          level: "info",
          message:
            `chainalysis_oracle: isSanctioned=${result.isSanctioned} (chain=${chain})`,
          at: now(),
        });
        return { chain, result };
      } catch (e) {
        const msg = (e as Error).message;
        safeEmit(emit, {
          type: "service",
          status: "error",
          category: "sanctions",
          resource,
          kind: "direct",
          priceUsdc: 0,
          request_id,
          duration_ms: Date.now() - start,
          cost_usd: null,
          error: msg,
          at: now(),
        });
        safeEmit(emit, {
          type: "log",
          level: "warn",
          message: `chainalysis_oracle_failed: ${chain} ${msg}`,
          at: now(),
        });
        return { chain, error: msg };
      }
    }),
  );
  return attempts;
}

// Resolve ENS with structured service events so the UI flow diagram can
// render this chain-primitive path alongside the x402 categories.
async function resolveEnsWithEvents(
  address: string,
  ensResolveFn: typeof resolveEns,
  emit: EventEmitter | undefined,
  request_id: string,
): Promise<Awaited<ReturnType<typeof resolveEns>> | null> {
  const resource = `ens://${DEFAULT_CHAIN}`;
  const start = Date.now();
  safeEmit(emit, {
    type: "service",
    status: "start",
    category: "ens",
    resource,
    kind: "direct",
    priceUsdc: 0,
    request_id,
    duration_ms: 0,
    cost_usd: null,
    at: now(),
  });
  try {
    const result = await ensResolveFn(address, DEFAULT_CHAIN);
    const duration_ms = Date.now() - start;
    safeEmit(emit, {
      type: "service",
      status: "ok",
      category: "ens",
      resource,
      kind: "direct",
      priceUsdc: 0,
      amountUsdc: 0,
      request_id,
      duration_ms,
      cost_usd: null,
      at: now(),
    });
    // Always emit a log line with the concrete outcome. The UI's LogStream
    // surfaces this as the human-readable proof that ENS ran, even when the
    // wallet has no primary name (which is the common case for non-doxxed
    // addresses).
    safeEmit(emit, {
      type: "log",
      level: "info",
      message: result.ensName
        ? `ens_resolve: ${address} → ${result.ensName}`
        : `ens_resolve: ${address} → no_primary_name`,
      at: now(),
    });
    return result;
  } catch (e) {
    const msg = (e as Error).message || "(unknown ENS RPC failure)";
    const duration_ms = Date.now() - start;
    safeEmit(emit, {
      type: "service",
      status: "error",
      category: "ens",
      resource,
      kind: "direct",
      priceUsdc: 0,
      request_id,
      duration_ms,
      cost_usd: null,
      error: msg,
      at: now(),
    });
    safeEmit(emit, {
      type: "log",
      level: "warn",
      message: `ens_resolve_failed: ${msg}`,
      at: now(),
    });
    return null;
  }
}

export async function verifyAgent(
  req: VerifyRequest,
  opts: VerifyAgentOpts = {},
): Promise<VerifyAgentResult> {
  const requestedCategories = opts.categories ?? DEFAULT_CATEGORIES;
  // Wrap the LLM client once so every model call in the pipeline (descriptor
  // retry, verdict synthesis) accrues into a single cost sink we report as
  // totalLlmCostUsd. We wrap `opts.llm ?? defaultLlm` rather than only a
  // caller-supplied client: in production the route passes no llm, so each
  // component would otherwise fall back to its own unwrapped defaultLlm and the
  // cost would never be captured. Passing the wrapped default down is
  // behavior-neutral — those components already use defaultLlm when no client
  // is supplied (selectFromRegistry makes no LLM calls at all).
  const llmCostSink = { totalUsd: 0 };
  const llm = withCostTracking(opts.llm ?? defaultLlm, llmCostSink);
  const emit = opts.onEvent;
  const hooks = opts._testHooks ?? {};
  const selectFn = hooks.selectFromRegistry ?? selectFromRegistry;
  const invokeAllFn = hooks.invokeAll ?? invokeAll;
  const synthesizeFn = hooks.synthesizeVerdict ?? synthesizeVerdict;
  const oracleCheckFn = hooks.checkSanctionsOracle ?? checkSanctionsOracle;
  const ensResolveFn = hooks.resolveEns ?? resolveEns;
  const labelsRegistryFn = hooks.fetchLabelsRegistry ?? fetchLabelsRegistry;
  const cache = opts.verdictCache ?? null;
  const denylist = opts.denylist ?? null;
  const depth: VerifyDepth = opts.depth ?? "deep";
  const request_id = opts.request_id ?? crypto.randomUUID();

  // Cache check before any service calls — hit returns in <100ms.
  if (cache) {
    const cached = await cache.get(DEFAULT_CHAIN, req.address);
    if (cached !== null) {
      safeEmit(emit, {
        type: "log",
        level: "info",
        message:
          `verdict_cache: hit verdict=${cached.verdict} address=${req.address}`,
        at: now(),
      });
      const walletNetwork: WalletNetwork = "base";
      return {
        verdict: cached,
        plan: {
          address: req.address,
          walletNetwork,
          services: [],
          alternates: {},
          totalEstimatedCostUsdc: 0,
          unresolvedCategories: [],
          deterministicSources: [],
          generatedAt: new Date().toISOString(),
        },
        outcomes: [],
        walletNetwork,
        totalSpentUsdc: 0,
        totalLlmCostUsd: 0,
        tier: depth,
        fastSignal: fastSignalForVerdict(cached.verdict),
      };
    }
  }

  const notApplicable: Category[] = [];
  let categories = requestedCategories;

  // ENS reverse resolution only exists natively on Ethereum mainnet. Since
  // DEFAULT_CHAIN is eth this branch is currently a no-op, but kept so the
  // skip-logic still works if we ever change defaults.
  if (categories.includes("ens") && !ensSupportedFor(DEFAULT_CHAIN)) {
    notApplicable.push("ens");
    categories = categories.filter((c) => c !== "ens");
    safeEmit(emit, {
      type: "log",
      level: "info",
      message:
        `category_skipped: ens reason=chain_not_supported (${DEFAULT_CHAIN})`,
      at: now(),
    });
  }

  // DENYLIST FAST-PATH: a warmed OFAC SDN hit returns a deterministic verdict
  // from a single KV read — before the oracle fan-out — at zero spend and no
  // RPC. A miss falls through to the live oracle path below, so correctness
  // never depends on the denylist being warm.
  if (denylist) {
    const entry = await denylist.has(DEFAULT_CHAIN, req.address);
    if (entry !== null) {
      safeEmit(emit, {
        type: "log",
        level: "info",
        message:
          `sanctioned_denylist: hit address=${req.address} source=${entry.source}`,
        at: now(),
      });
      const walletNetwork: WalletNetwork = "base";
      const verdict = denylistVerdict(req, categories, notApplicable, entry);
      return {
        verdict,
        plan: {
          address: req.address,
          walletNetwork,
          services: [],
          alternates: {},
          totalEstimatedCostUsdc: 0,
          unresolvedCategories: [],
          deterministicSources: [],
          generatedAt: new Date().toISOString(),
        },
        outcomes: [],
        walletNetwork,
        totalSpentUsdc: 0,
        totalLlmCostUsd: 0,
        tier: depth,
        fastSignal: "block",
      };
    }
  }

  // CHAIN-PRIMITIVE FALLBACK: hit the Chainalysis sanctions oracle on every
  // supported EVM chain in parallel before running discovery + x402
  // invocation. If ANY chain returns isSanctioned=true, short-circuit to a
  // deterministic verdict with zero spend. On RPC errors for an individual
  // chain we keep going — the strictest signal across the surviving chains
  // still gates the verdict, and the regular sanctions x402 service runs
  // afterwards if no chain flagged the address.
  const oracleAttempts = await checkOracleAcrossChains(
    req.address,
    oracleCheckFn,
    emit,
    request_id,
  );
  const flaggedAttempt = oracleAttempts.find((a) =>
    a.result?.isSanctioned === true
  );
  if (flaggedAttempt && flaggedAttempt.result) {
    console.warn(
      `[verify-agent] Chainalysis oracle flagged ${req.address} as sanctioned on ${flaggedAttempt.chain} — short-circuiting (no x402 spend)`,
    );
    const walletNetwork: WalletNetwork = "base";
    const sanctionedVerdict = oracleSanctionedVerdict(
      req,
      categories,
      notApplicable,
      flaggedAttempt.result,
    );
    if (cache) await cache.set(DEFAULT_CHAIN, req.address, sanctionedVerdict);
    return {
      verdict: sanctionedVerdict,
      plan: {
        address: req.address,
        walletNetwork,
        services: [],
        alternates: {},
        totalEstimatedCostUsdc: 0,
        unresolvedCategories: [],
        deterministicSources: [],
        generatedAt: new Date().toISOString(),
      },
      outcomes: [],
      walletNetwork,
      totalSpentUsdc: 0,
      totalLlmCostUsd: 0,
      tier: depth,
      fastSignal: "block",
    };
  }
  // Prefer the eth result for merging into findings (deepest coverage). Fall
  // back to any successful clean result if eth failed.
  const oracleResult: OracleResult | null =
    oracleAttempts.find((a) => a.chain === "eth" && a.result)?.result ??
      oracleAttempts.find((a) => a.result)?.result ?? null;

  // FAST TIER: the free sanctions gate (denylist + oracle) cleared the address
  // and no x402 spend has occurred. Return a machine-readable
  // "needs_deep_check" signal instead of running discovery + the paid fanout +
  // synthesis. The caller opts into the deep tier (depth="deep") when it wants a
  // final safe/unsafe verdict.
  if (depth === "fast") {
    safeEmit(emit, {
      type: "log",
      level: "info",
      message:
        `fast_tier: sanctions gate cleared, returning needs_deep_check (no spend) address=${req.address}`,
      at: now(),
    });
    const walletNetwork: WalletNetwork = "base";
    return {
      verdict: fastNeedsDeepVerdict(
        req,
        categories,
        notApplicable,
        oracleResult,
      ),
      plan: {
        address: req.address,
        walletNetwork,
        services: [],
        alternates: {},
        totalEstimatedCostUsdc: 0,
        unresolvedCategories: [],
        deterministicSources: [],
        generatedAt: new Date().toISOString(),
      },
      outcomes: [],
      walletNetwork,
      totalSpentUsdc: 0,
      totalLlmCostUsd: 0,
      tier: "fast",
      fastSignal: "needs_deep_check",
    };
  }

  const discoverStart = Date.now();
  safeEmit(emit, {
    type: "phase",
    phase: "discover",
    status: "start",
    request_id,
    duration_ms: 0,
    at: now(),
  });
  // HOT-PATH SWAP (W0.4): the request path reads the curated service_registry
  // instead of fanning out to Bazaar + LLM rerank. discover() is preserved but
  // now only runs off the hot path (snapshot-recipes, the W0.10 vetter). The
  // emitted phase keeps the "discover" label so the SSE/UI contract is stable.
  const plan = await selectFn(req.address, categories, {
    llm,
    onEvent: emit,
    request_id,
  });
  safeEmit(emit, {
    type: "plan",
    services: plan.services.map((s) => ({
      category: s.category,
      resource: s.resource,
      priceUsdc: s.priceUsdc,
      rationale: s.rationale,
    })),
    totalEstimatedCostUsdc: plan.totalEstimatedCostUsdc,
    walletNetwork: plan.walletNetwork,
    at: now(),
  });
  safeEmit(emit, {
    type: "phase",
    phase: "discover",
    status: "end",
    request_id,
    duration_ms: Date.now() - discoverStart,
    at: now(),
  });

  const invokeStart = Date.now();
  safeEmit(emit, {
    type: "phase",
    phase: "invoke",
    status: "start",
    request_id,
    duration_ms: 0,
    at: now(),
  });
  // Run x402 invocation, the ENS chain-primitive resolver, and the
  // hardcoded eth-labels.com registry supplement in parallel — all three
  // are independent. ENS + registry failures are silent (resolved as null)
  // since they're supplementary signals, not gates.
  const wantEns = categories.includes("ens");
  const wantLabels = categories.includes("labels");
  const [invocation, ensSettled, registrySettled] = await Promise.all([
    invokeAllFn(plan, DEFAULT_CHAIN, { llm, onEvent: emit, request_id }),
    wantEns
      ? resolveEnsWithEvents(req.address, ensResolveFn, emit, request_id)
      : Promise.resolve(null),
    wantLabels
      ? labelsRegistryFn(req.address, DEFAULT_CHAIN).catch((e: Error) => {
        console.warn(
          `[verify-agent] eth-labels registry lookup failed (proceeding): ${e.message}`,
        );
        safeEmit(emit, {
          type: "log",
          level: "warn",
          message: `labels_registry_failed: ${e.message}`,
          at: now(),
        });
        return null;
      })
      : Promise.resolve(null),
  ]);
  safeEmit(emit, {
    type: "phase",
    phase: "invoke",
    status: "end",
    request_id,
    duration_ms: Date.now() - invokeStart,
    at: now(),
  });

  if (wantLabels && registrySettled !== null) {
    safeEmit(emit, {
      type: "log",
      level: "info",
      message:
        `labels_registry: hits=${registrySettled.labels.length} (endpoint=${registrySettled.endpoint})`,
      at: now(),
    });
    const prior = invocation.findings.labels;
    invocation.findings.labels = prior !== undefined
      ? { x402_result: prior, registry: registrySettled }
      : { registry: registrySettled };
    // If x402 labels failed but the registry succeeded, the category is
    // no longer unresolved — synthesis has usable data.
    invocation.unresolved = invocation.unresolved.filter((c) => c !== "labels");
  }

  // Merge oracle-clean evidence into the sanctions finding so synthesis can
  // weigh it as a strong positive signal alongside any x402 sanctions result.
  if (oracleResult && !oracleResult.isSanctioned) {
    const prior = invocation.findings.sanctions;
    invocation.findings.sanctions = prior !== undefined
      ? { x402_result: prior, chainalysis_oracle: oracleResult }
      : { chainalysis_oracle: oracleResult };
  }

  // Merge ENS result. Unresolved → drop from invocation.unresolved so synthesis
  // doesn't penalize the verdict for a chain-primitive call we ran ourselves.
  if (wantEns) {
    if (ensSettled !== null) {
      invocation.findings.ens = ensSettled;
    }
    invocation.unresolved = invocation.unresolved.filter((c) => c !== "ens");
  }

  const resolved = Object.keys(invocation.findings) as Category[];
  let verdict: WalletVerdict;
  let synthesisError: string | undefined;
  const synthesizeStart = Date.now();
  safeEmit(emit, {
    type: "phase",
    phase: "synthesize",
    status: "start",
    request_id,
    duration_ms: 0,
    at: now(),
  });
  try {
    verdict = await synthesizeFn({
      address: req.address,
      chain: DEFAULT_CHAIN,
      findings: invocation.findings,
      coverage: {
        requested: categories,
        resolved,
        unresolved: invocation.unresolved,
        ...(notApplicable.length > 0 ? { not_applicable: notApplicable } : {}),
      },
      totalSpentUsdc: invocation.totalSpentUsdc,
    }, { llm });
  } catch (e) {
    synthesisError = (e as Error).message;
    console.error(
      `[verify-agent] synthesis failed; returning stub verdict with preserved receipts: ${synthesisError}`,
    );
    safeEmit(emit, {
      type: "log",
      level: "error",
      code: "synthesis_failed",
      message: `synthesis failed: ${synthesisError}`,
      at: now(),
    });
    verdict = stubVerdict(
      req,
      categories,
      resolved,
      invocation.unresolved,
      notApplicable,
      invocation.totalSpentUsdc,
      synthesisError,
    );
  }
  safeEmit(emit, {
    type: "phase",
    phase: "synthesize",
    status: "end",
    request_id,
    duration_ms: Date.now() - synthesizeStart,
    at: now(),
  });

  if (cache) await cache.set(DEFAULT_CHAIN, req.address, verdict);

  return {
    verdict,
    plan,
    outcomes: invocation.outcomes,
    walletNetwork: invocation.walletNetwork,
    totalSpentUsdc: invocation.totalSpentUsdc,
    totalLlmCostUsd: llmCostSink.totalUsd,
    synthesisError,
    tier: "deep",
    fastSignal: fastSignalForVerdict(verdict.verdict),
  };
}
