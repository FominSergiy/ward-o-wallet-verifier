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
  const invocation = await invokeAllFn(plan, req.chain, { llm, onEvent: emit });
  safeEmit(emit, { type: "phase", phase: "invoke", status: "end", at: now() });

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
