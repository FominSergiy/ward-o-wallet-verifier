import { invokeRankedService, type ServiceInvocationOutcome } from "./invoke_service.ts";
import type {
  DiscoveryPlan,
  RankedService,
  WalletNetwork,
} from "../discovery/types.ts";
import { recordError, recordOk } from "../discovery/health_store.ts";
import type { LlmClient } from "./llm.ts";
import type { Chain } from "../dag/types.ts";
import type { Category } from "./types.ts";

// Cap retries per category — catalog can have 5+ alternates but we don't want
// to burn time/money exhaustively probing dead services.
const MAX_ALTERNATES_PER_CATEGORY = 2;

// When an upstream error matches one of these patterns, treat the failure as
// host-level (the entire domain is dead / non-x402) and skip subsequent
// alternates from the same host. Saves a wasted LLM-adapter call + agnicFetch
// roundtrip per skipped sibling.
const DOMAIN_LEVEL_ERROR_PATTERNS = [
  /Target API is not X402 enabled/i,
  /\bNot Found\b/i,
  /\bDNS\b/i,
  /upstream_404/i,
];

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isDomainLevelError(message: string | undefined): boolean {
  if (!message) return false;
  return DOMAIN_LEVEL_ERROR_PATTERNS.some((re) => re.test(message));
}

export type Findings = Partial<Record<Category, unknown>>;

export interface InvokeAllResult {
  findings: Findings;
  outcomes: ServiceInvocationOutcome[];
  unresolved: Category[];
  totalSpentUsdc: number;
  walletNetwork: WalletNetwork;
}

export class SanctionsInvocationError extends Error {
  constructor(public readonly underlying: string) {
    super(`sanctions invocation failed: ${underlying}`);
    this.name = "SanctionsInvocationError";
  }
}

export interface InvokeAllOpts {
  llm?: LlmClient;
  // Optional invoker override for tests.
  invoker?: (
    service: DiscoveryPlan["services"][number],
    address: string,
    chain: Chain,
    opts: { llm?: LlmClient },
  ) => Promise<ServiceInvocationOutcome>;
}

async function invokeWithAlternates(
  primary: RankedService,
  alternates: RankedService[],
  address: string,
  chain: Chain,
  invoker: NonNullable<InvokeAllOpts["invoker"]>,
  llm?: LlmClient,
): Promise<ServiceInvocationOutcome> {
  const candidates = [primary, ...alternates.slice(0, MAX_ALTERNATES_PER_CATEGORY)];
  const failedHosts = new Set<string>();
  let lastOutcome: ServiceInvocationOutcome | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const svc = candidates[i];
    const host = hostOf(svc.resource);
    if (failedHosts.has(host)) {
      console.warn(
        `[invoke] skipping ${svc.resource} — host ${host} already failed with domain-level error`,
      );
      continue;
    }
    const outcome = await invoker(svc, address, chain, { llm });
    // Update health stats so future rerank calls can weight this service.
    if (outcome.status === "ok" || outcome.status === "fallback_ok") {
      recordOk(svc.resource);
      if (i > 0) {
        console.warn(
          `[invoke] primary failed for ${primary.category}; succeeded on alternate ${svc.resource}`,
        );
      }
      return outcome;
    }
    recordError(svc.resource, outcome.error ?? "(unknown)");
    lastOutcome = outcome;
    if (isDomainLevelError(outcome.error)) {
      failedHosts.add(host);
    }
    if (i < candidates.length - 1) {
      console.warn(
        `[invoke] ${primary.category}: ${svc.resource} errored (${outcome.error}); trying next alternate`,
      );
    }
  }
  return lastOutcome!;
}

export async function invokeAll(
  plan: DiscoveryPlan,
  chain: Chain,
  opts: InvokeAllOpts = {},
): Promise<InvokeAllResult> {
  const invoker = opts.invoker ?? invokeRankedService;

  const outcomes = await Promise.all(
    plan.services.map((s) =>
      invokeWithAlternates(
        s,
        plan.alternates[s.category] ?? [],
        plan.address,
        chain,
        invoker,
        opts.llm,
      )
    ),
  );

  // Fail-fast on sanctions error.
  const sanctionsOutcome = outcomes.find((o) => o.category === "sanctions");
  if (sanctionsOutcome) {
    if (sanctionsOutcome.status === "error") {
      throw new SanctionsInvocationError(
        sanctionsOutcome.error ?? "(unknown)",
      );
    }
  } else {
    console.warn(
      "[invoke] sanctions not in plan — proceeding without OFAC gate",
    );
  }

  const findings: Findings = {};
  const unresolved: Category[] = [];
  let totalSpentUsdc = 0;

  for (const o of outcomes) {
    if (o.status === "ok" || o.status === "fallback_ok") {
      findings[o.category] = o.data;
      totalSpentUsdc += o.amountUsdc;
    } else {
      unresolved.push(o.category);
    }
  }

  return {
    findings,
    outcomes,
    unresolved,
    totalSpentUsdc,
    walletNetwork: plan.walletNetwork,
  };
}
