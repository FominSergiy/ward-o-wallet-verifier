import type { VerifyRequest } from "./types.ts";
import type { LlmClient } from "./llm.ts";
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
  // Populated when the Opus synthesis call failed; the verdict above is a
  // conservative stub ("insufficient_data" / safe=false). All paid receipts
  // are still preserved so the caller can render or re-synthesize manually.
  synthesisError?: string;
}

export interface VerifyAgentOpts {
  budgetCeiling?: number;
  llm?: LlmClient;
  categories?: Category[];
  onEvent?: EventEmitter;
  request_id?: string;
  verdictCache?: VerdictCache;
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
  const llm = opts.llm;
  const emit = opts.onEvent;
  const hooks = opts._testHooks ?? {};
  const selectFn = hooks.selectFromRegistry ?? selectFromRegistry;
  const invokeAllFn = hooks.invokeAll ?? invokeAll;
  const synthesizeFn = hooks.synthesizeVerdict ?? synthesizeVerdict;
  const oracleCheckFn = hooks.checkSanctionsOracle ?? checkSanctionsOracle;
  const ensResolveFn = hooks.resolveEns ?? resolveEns;
  const labelsRegistryFn = hooks.fetchLabelsRegistry ?? fetchLabelsRegistry;
  const cache = opts.verdictCache ?? null;
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
    };
  }
  // Prefer the eth result for merging into findings (deepest coverage). Fall
  // back to any successful clean result if eth failed.
  const oracleResult: OracleResult | null =
    oracleAttempts.find((a) => a.chain === "eth" && a.result)?.result ??
      oracleAttempts.find((a) => a.result)?.result ?? null;

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
    synthesisError,
  };
}
