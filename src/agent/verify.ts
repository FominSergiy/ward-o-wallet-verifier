import type { VerifyRequest } from "./types.ts";
import type { LlmClient } from "./llm.ts";
import type { Category } from "./types.ts";
import { discover } from "../discovery/discover.ts";
import { invokeAll } from "./invoke_all.ts";
import { synthesizeVerdict } from "./synthesize_verdict.ts";
import type { WalletVerdict } from "./verdict.ts";
import type { DiscoveryPlan, WalletNetwork } from "../discovery/types.ts";
import type { ServiceInvocationOutcome } from "./invoke_service.ts";

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
  // Injection seam for unit tests — replace any of the discovery-flow
  // collaborators. Real callers leave undefined and the default
  // implementations are used.
  _testHooks?: {
    discover?: typeof discover;
    invokeAll?: typeof invokeAll;
    synthesizeVerdict?: typeof synthesizeVerdict;
  };
}

function stubVerdict(
  req: VerifyRequest,
  categories: Category[],
  resolved: Category[],
  unresolved: Category[],
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
    coverage: { requested: categories, resolved, unresolved },
    totalSpentUsdc,
    generatedAt: new Date().toISOString(),
  };
}

export async function verifyAgent(
  req: VerifyRequest,
  opts: VerifyAgentOpts = {},
): Promise<VerifyAgentResult> {
  const categories = opts.categories ?? DEFAULT_CATEGORIES;
  const llm = opts.llm;
  const hooks = opts._testHooks ?? {};
  const discoverFn = hooks.discover ?? discover;
  const invokeAllFn = hooks.invokeAll ?? invokeAll;
  const synthesizeFn = hooks.synthesizeVerdict ?? synthesizeVerdict;

  const plan = await discoverFn(req.address, categories, { llm });
  const invocation = await invokeAllFn(plan, req.chain, { llm });

  const resolved = Object.keys(invocation.findings) as Category[];
  let verdict: WalletVerdict;
  let synthesisError: string | undefined;
  try {
    verdict = await synthesizeFn({
      address: req.address,
      chain: req.chain,
      findings: invocation.findings,
      coverage: {
        requested: categories,
        resolved,
        unresolved: invocation.unresolved,
      },
      totalSpentUsdc: invocation.totalSpentUsdc,
    }, { llm });
  } catch (e) {
    synthesisError = (e as Error).message;
    console.error(
      `[verify-agent] synthesis failed; returning stub verdict with preserved receipts: ${synthesisError}`,
    );
    verdict = stubVerdict(
      req,
      categories,
      resolved,
      invocation.unresolved,
      invocation.totalSpentUsdc,
      synthesisError,
    );
  }

  return {
    verdict,
    plan,
    outcomes: invocation.outcomes,
    walletNetwork: invocation.walletNetwork,
    totalSpentUsdc: invocation.totalSpentUsdc,
    synthesisError,
  };
}
