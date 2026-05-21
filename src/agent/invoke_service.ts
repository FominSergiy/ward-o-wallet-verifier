import { agnicFetch, AgnicFetchError } from "../clients/agnic.ts";
import {
  AdapterFailedError,
  buildCallFromInfo,
  buildCallFromInfoViaLlm,
  type BuiltCall,
} from "../discovery/adapter.ts";
import type { RankedService } from "../discovery/types.ts";
import { defaultLlm, type LlmClient } from "./llm.ts";
import type { Chain } from "../dag/types.ts";
import type { Category } from "./types.ts";

export interface ServiceInvocationOutcome {
  category: Category;
  resource: string;
  data: unknown | null;
  status: "ok" | "fallback_ok" | "error";
  error?: string;
  amountUsdc: number;
  durationMs: number;
  paid: boolean;
  network: string | null;
  adapterPath: "pattern" | "llm";
}

// Error codes from agnicFetch that should NEVER trigger an LLM fallback —
// they're payment/transport problems, not input-shape problems.
const HARD_ERROR_CODES = new Set([
  "insufficient_balance",
  "payment_exceeds_max",
  "no_wallet",
  "rate_limited",
]);

function isUpstreamInputError(err: AgnicFetchError): boolean {
  if (HARD_ERROR_CODES.has(err.code)) return false;
  // Heuristic: 5xx and network-level codes shouldn't be retried via fallback.
  if (/^upstream_5/i.test(err.code)) return false;
  if (/^network_/i.test(err.code)) return false;
  // Everything else (upstream_4xx, bad_request, invalid_request, unknown_error,
  // and miscellaneous catch-alls) likely points at our request shape.
  return true;
}

async function performCall(
  built: BuiltCall,
  priceUsdc: number,
): Promise<{
  data: unknown;
  amountUsdc: number;
  paid: boolean;
  network: string | null;
}> {
  const result = await agnicFetch(built.url, {
    method: built.method,
    body: built.method === "POST" ? built.body : undefined,
    maxValueUsd: priceUsdc,
  });
  return {
    data: result.data,
    amountUsdc: result.amountUsd,
    paid: result.paid,
    network: result.network,
  };
}

export async function invokeRankedService(
  service: RankedService,
  address: string,
  chain: Chain,
  opts: { llm?: LlmClient } = {},
): Promise<ServiceInvocationOutcome> {
  const llm = opts.llm ?? defaultLlm;
  const start = Date.now();

  // Layer 1: pattern-match adapter.
  let built: BuiltCall;
  try {
    built = buildCallFromInfo(service, address, chain);
  } catch (e) {
    const err = e as Error;
    return {
      category: service.category,
      resource: service.resource,
      data: null,
      status: "error",
      error: `pattern-adapter: ${err.message}`,
      amountUsdc: 0,
      durationMs: Date.now() - start,
      paid: false,
      network: null,
      adapterPath: "pattern",
    };
  }

  try {
    const r = await performCall(built, service.priceUsdc);
    return {
      category: service.category,
      resource: service.resource,
      data: r.data,
      status: "ok",
      amountUsdc: r.amountUsdc,
      durationMs: Date.now() - start,
      paid: r.paid,
      network: r.network,
      adapterPath: "pattern",
    };
  } catch (e) {
    // Hard errors: surface immediately. No fallback, no log spam.
    if (e instanceof AgnicFetchError && !isUpstreamInputError(e)) {
      return {
        category: service.category,
        resource: service.resource,
        data: null,
        status: "error",
        error: e.message,
        amountUsdc: 0,
        durationMs: Date.now() - start,
        paid: false,
        network: null,
        adapterPath: "pattern",
      };
    }

    // Layer 2: LLM-built call. Log that we're falling back.
    console.warn(
      `[invoke] pattern-match failed for ${service.resource} — trying LLM fallback (${(e as Error).message})`,
    );

    let llmBuilt: BuiltCall;
    try {
      llmBuilt = await buildCallFromInfoViaLlm(service, address, chain, llm);
    } catch (lerr) {
      const reason = lerr instanceof AdapterFailedError
        ? lerr.message
        : (lerr as Error).message;
      console.error(
        `[invoke] both adapters failed for ${service.resource}: ${reason}`,
      );
      return {
        category: service.category,
        resource: service.resource,
        data: null,
        status: "error",
        error: reason,
        amountUsdc: 0,
        durationMs: Date.now() - start,
        paid: false,
        network: null,
        adapterPath: "llm",
      };
    }

    try {
      const r = await performCall(llmBuilt, service.priceUsdc);
      return {
        category: service.category,
        resource: service.resource,
        data: r.data,
        status: "fallback_ok",
        amountUsdc: r.amountUsdc,
        durationMs: Date.now() - start,
        paid: r.paid,
        network: r.network,
        adapterPath: "llm",
      };
    } catch (e2) {
      const msg = (e2 as Error).message;
      console.error(
        `[invoke] both adapters failed for ${service.resource}: ${msg}`,
      );
      return {
        category: service.category,
        resource: service.resource,
        data: null,
        status: "error",
        error: msg,
        amountUsdc: 0,
        durationMs: Date.now() - start,
        paid: false,
        network: null,
        adapterPath: "llm",
      };
    }
  }
}
