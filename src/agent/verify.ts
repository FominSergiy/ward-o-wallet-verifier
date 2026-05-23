import type { VerifyRequest } from "./types.ts";
import type { LlmClient } from "./llm.ts";
import type { Category } from "./types.ts";
import { discover } from "../discovery/discover.ts";
import { invokeAll } from "./invoke_all.ts";
import { synthesizeVerdict } from "./synthesize_verdict.ts";
import type { WalletVerdict } from "./verdict.ts";
import type { DiscoveryPlan, WalletNetwork } from "../discovery/types.ts";
import type { ServiceInvocationOutcome } from "./invoke_service.ts";
import { type EventEmitter, now, safeEmit } from "./events.ts";
import { isContract } from "./onchain_viem.ts";
import {
  checkSanctionsOracle,
  isOracleSupportedChain,
  type OracleResult,
} from "./sanctions_oracle.ts";
import { ensSupportedFor, resolveEns } from "./ens_resolver.ts";

// Categories that only produce signal for contract addresses. Dropped early
// for EOAs so we don't burn $0.005 on a smart-contract auditor that returns
// "no source code" and contributes nothing to the verdict.
const CONTRACT_ONLY_CATEGORIES: ReadonlySet<Category> = new Set([
  "contract_analysis",
]);

const DEFAULT_CATEGORIES: Category[] = [
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
  "ens",
  "contract_analysis",
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
  // Injection seam for unit tests — replace any of the discovery-flow
  // collaborators. Real callers leave undefined and the default
  // implementations are used.
  _testHooks?: {
    discover?: typeof discover;
    invokeAll?: typeof invokeAll;
    synthesizeVerdict?: typeof synthesizeVerdict;
    isContract?: typeof isContract;
    checkSanctionsOracle?: typeof checkSanctionsOracle;
    resolveEns?: typeof resolveEns;
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
    chain: req.chain,
    safe: false,
    verdict: "insufficient_data",
    confidence: "low",
    headline: `Synthesis failed — manual review required: ${errorMessage.slice(0, 120)}`,
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
// Chainalysis sanctions oracle returns isSanctioned=true. We bypass discovery,
// x402 invocation and Opus synthesis entirely — the oracle is a definitive
// negative-truth signal and further spend would be wasted.
function oracleSanctionedVerdict(
  req: VerifyRequest,
  categories: Category[],
  notApplicable: Category[],
  oracle: OracleResult,
): WalletVerdict {
  return {
    address: req.address,
    chain: req.chain,
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
        `Chainalysis sanctions oracle returned isSanctioned=true at ${oracle.oracleAddress}.`,
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

export async function verifyAgent(
  req: VerifyRequest,
  opts: VerifyAgentOpts = {},
): Promise<VerifyAgentResult> {
  const requestedCategories = opts.categories ?? DEFAULT_CATEGORIES;
  const llm = opts.llm;
  const emit = opts.onEvent;
  const hooks = opts._testHooks ?? {};
  const discoverFn = hooks.discover ?? discover;
  const invokeAllFn = hooks.invokeAll ?? invokeAll;
  const synthesizeFn = hooks.synthesizeVerdict ?? synthesizeVerdict;
  const isContractFn = hooks.isContract ?? isContract;
  const oracleCheckFn = hooks.checkSanctionsOracle ?? checkSanctionsOracle;
  const ensResolveFn = hooks.resolveEns ?? resolveEns;

  // EOA short-circuit: drop contract-only categories when the address has no
  // deployed bytecode. Tracked separately as `not_applicable` so the verdict's
  // confidence isn't penalized for missing this category.
  const notApplicable: Category[] = [];
  let categories = requestedCategories;
  const requestedContractOnly = requestedCategories.filter((c) =>
    CONTRACT_ONLY_CATEGORIES.has(c)
  );
  if (requestedContractOnly.length > 0) {
    const addressIsContract = await isContractFn(req.address, req.chain);
    if (!addressIsContract) {
      notApplicable.push(...requestedContractOnly);
      categories = requestedCategories.filter(
        (c) => !CONTRACT_ONLY_CATEGORIES.has(c),
      );
      console.warn(
        `[verify-agent] address ${req.address} on ${req.chain} is an EOA — skipping categories: ${notApplicable.join(", ")}`,
      );
      safeEmit(emit, {
        type: "log",
        level: "info",
        message: `category_skipped: ${notApplicable.join(",")} reason=address_is_eoa`,
        at: now(),
      });
    }
  }

  // ENS reverse resolution only exists natively on Ethereum mainnet. Drop the
  // category for other chains so it doesn't penalize confidence as
  // "unresolved" — it's genuinely not applicable.
  if (categories.includes("ens") && !ensSupportedFor(req.chain)) {
    notApplicable.push("ens");
    categories = categories.filter((c) => c !== "ens");
    safeEmit(emit, {
      type: "log",
      level: "info",
      message: `category_skipped: ens reason=chain_not_supported (${req.chain})`,
      at: now(),
    });
  }

  // CHAIN-PRIMITIVE FALLBACK: hit the Chainalysis sanctions oracle before
  // running discovery + x402 invocation. If sanctioned, short-circuit to a
  // deterministic verdict with zero spend. On RPC errors or unsupported
  // chains, fall through silently — the regular sanctions x402 service still
  // runs and synthesis will handle the result. See sanctions_oracle.ts.
  let oracleResult: OracleResult | null = null;
  if (isOracleSupportedChain(req.chain)) {
    try {
      oracleResult = await oracleCheckFn(req.address, req.chain);
      safeEmit(emit, {
        type: "log",
        level: "info",
        message:
          `chainalysis_oracle: isSanctioned=${oracleResult.isSanctioned} (chain=${req.chain})`,
        at: now(),
      });
      if (oracleResult.isSanctioned) {
        console.warn(
          `[verify-agent] Chainalysis oracle flagged ${req.address} as sanctioned — short-circuiting (no x402 spend)`,
        );
        const walletNetwork: WalletNetwork = "base";
        return {
          verdict: oracleSanctionedVerdict(
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
            generatedAt: new Date().toISOString(),
          },
          outcomes: [],
          walletNetwork,
          totalSpentUsdc: 0,
        };
      }
    } catch (e) {
      console.warn(
        `[verify-agent] Chainalysis oracle check failed (proceeding with x402 flow): ${(e as Error).message}`,
      );
      safeEmit(emit, {
        type: "log",
        level: "warn",
        message: `chainalysis_oracle_failed: ${(e as Error).message}`,
        at: now(),
      });
    }
  }

  safeEmit(emit, { type: "phase", phase: "discover", status: "start", at: now() });
  const plan = await discoverFn(req.address, categories, { llm, onEvent: emit });
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
  safeEmit(emit, { type: "phase", phase: "discover", status: "end", at: now() });

  safeEmit(emit, { type: "phase", phase: "invoke", status: "start", at: now() });
  // Run x402 invocation and the ENS chain-primitive resolver in parallel —
  // they're independent. ENS failures are silent (set to null) since ENS is
  // a confirmatory signal, not a gate.
  const wantEns = categories.includes("ens");
  const [invocation, ensSettled] = await Promise.all([
    invokeAllFn(plan, req.chain, { llm, onEvent: emit }),
    wantEns
      ? ensResolveFn(req.address, req.chain).catch((e: Error) => {
        console.warn(
          `[verify-agent] ENS reverse resolution failed (proceeding): ${e.message}`,
        );
        return null;
      })
      : Promise.resolve(null),
  ]);
  safeEmit(emit, { type: "phase", phase: "invoke", status: "end", at: now() });

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
  safeEmit(emit, { type: "phase", phase: "synthesize", status: "start", at: now() });
  try {
    verdict = await synthesizeFn({
      address: req.address,
      chain: req.chain,
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
  safeEmit(emit, { type: "phase", phase: "synthesize", status: "end", at: now() });

  return {
    verdict,
    plan,
    outcomes: invocation.outcomes,
    walletNetwork: invocation.walletNetwork,
    totalSpentUsdc: invocation.totalSpentUsdc,
    synthesisError,
  };
}
