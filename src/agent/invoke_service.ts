import { agnicFetch, AgnicFetchError } from "../clients/agnic.ts";
import {
  AdapterFailedError,
  buildCallFromInfoViaLlm,
  buildCallSetFromInfo,
  type BuiltCall,
} from "../discovery/adapter.ts";
import type { RankedService } from "../discovery/types.ts";
import { defaultLlm, type LlmClient } from "./llm.ts";
import type { Category, Chain } from "./types.ts";

export interface ServiceInvocationOutcome {
  category: Category;
  resource: string;
  data: unknown | null;
  status: "ok" | "fallback_ok" | "error";
  error?: string;
  /** AgnicFetchError code when the error came from the Agnic gateway. */
  errorCode?: string;
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
]);

function isUpstreamInputError(err: AgnicFetchError): boolean {
  if (HARD_ERROR_CODES.has(err.code)) return false;
  if (isRateLimitError(err)) return false;
  if (/^upstream_5/i.test(err.code)) return false;
  if (/^network_/i.test(err.code)) return false;
  return true;
}

function isRateLimitError(err: AgnicFetchError): boolean {
  if (err.code === "rate_limited") return true;
  if (/^upstream_429/i.test(err.code)) return true;
  if (/too many requests/i.test(err.message)) return true;
  return false;
}

const RATE_LIMIT_BACKOFF_MS = 5_000;

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

// Wraps performCall with a single rate-limit retry after a 5s backoff. Returns
// the call result (success) OR re-throws the LAST error (rate-limit AGAIN or
// any non-rate-limit error). Caller decides whether to LLM-fallback based on
// the re-thrown error.
async function performCallWithRateLimitRetry(
  built: BuiltCall,
  priceUsdc: number,
  resource: string,
): Promise<Awaited<ReturnType<typeof performCall>>> {
  try {
    return await performCall(built, priceUsdc);
  } catch (e) {
    if (e instanceof AgnicFetchError && isRateLimitError(e)) {
      console.warn(
        `[invoke] ${resource} rate-limited; backing off ${RATE_LIMIT_BACKOFF_MS}ms before retry`,
      );
      await new Promise((res) => setTimeout(res, RATE_LIMIT_BACKOFF_MS));
      return await performCall(built, priceUsdc);
    }
    throw e;
  }
}

function errorOutcome(
  service: RankedService,
  message: string,
  start: number,
  adapterPath: "pattern" | "llm",
  errorCode?: string,
): ServiceInvocationOutcome {
  return {
    category: service.category,
    resource: service.resource,
    data: null,
    status: "error",
    error: message,
    errorCode,
    amountUsdc: 0,
    durationMs: Date.now() - start,
    paid: false,
    network: null,
    adapterPath,
  };
}

function okOutcome(
  service: RankedService,
  r: Awaited<ReturnType<typeof performCall>>,
  start: number,
  status: "ok" | "fallback_ok",
  adapterPath: "pattern" | "llm",
): ServiceInvocationOutcome {
  return {
    category: service.category,
    resource: service.resource,
    data: r.data,
    status,
    amountUsdc: r.amountUsdc,
    durationMs: Date.now() - start,
    paid: r.paid,
    network: r.network,
    adapterPath,
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

  // Layer 1: pattern-match adapter — try the primary shape, then any
  // fallback shapes for POST endpoints.
  let callSet;
  try {
    callSet = buildCallSetFromInfo(service, address, chain);
  } catch (e) {
    return errorOutcome(service, `pattern-adapter: ${(e as Error).message}`, start, "pattern");
  }

  const patternShapes: BuiltCall[] = [callSet.primary, ...callSet.fallbacks];
  let lastError: unknown = null;
  for (let i = 0; i < patternShapes.length; i++) {
    const built = patternShapes[i];
    try {
      const r = await performCallWithRateLimitRetry(built, service.priceUsdc, service.resource);
      if (i > 0) {
        console.warn(
          `[invoke] ${service.resource} succeeded with fallback POST shape ${i} (body=${JSON.stringify(built.body).slice(0, 80)})`,
        );
      }
      return okOutcome(service, r, start, "ok", "pattern");
    } catch (e) {
      lastError = e;
      // Hard errors short-circuit — no point trying more pattern shapes.
      if (e instanceof AgnicFetchError && !isUpstreamInputError(e)) {
        return errorOutcome(service, e.message, start, "pattern", e.code);
      }
      // Otherwise continue to next shape (if any).
    }
  }

  // Layer 2: LLM-built call.
  console.warn(
    `[invoke] pattern-match failed for ${service.resource} (${patternShapes.length} shape(s) tried) — trying LLM fallback (${(lastError as Error)?.message})`,
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
    return errorOutcome(service, reason, start, "llm");
  }

  try {
    const r = await performCallWithRateLimitRetry(llmBuilt, service.priceUsdc, service.resource);
    return okOutcome(service, r, start, "fallback_ok", "llm");
  } catch (e2) {
    const msg = (e2 as Error).message;
    const code = e2 instanceof AgnicFetchError ? e2.code : undefined;
    console.error(`[invoke] both adapters failed for ${service.resource}: ${msg}`);
    return errorOutcome(service, msg, start, "llm", code);
  }
}
