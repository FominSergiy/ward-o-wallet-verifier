import { agnicFetch, AgnicFetchError } from "../clients/agnic.ts";
import { log } from "../observability/log.ts";
import {
  AdapterFailedError,
  assertNoUnsubstitutedPlaceholders,
  buildCallFromInfoViaLlm,
  buildCallSetFromInfo,
  type BuiltCall,
  isServiceDescriptor,
  pickActionEndpoint,
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
  adapterPath: "pattern" | "pattern+subpath" | "llm";
}

// Joins a sub-path onto a built URL while preserving any existing query
// string. Collapses duplicate slashes at the seam. Used when a service's root
// URL returns a descriptor and we retry against one of the declared endpoints.
export function appendSubPath(builtUrl: string, subPath: string): string {
  const qIdx = builtUrl.indexOf("?");
  const base = qIdx >= 0 ? builtUrl.slice(0, qIdx) : builtUrl;
  const query = qIdx >= 0 ? builtUrl.slice(qIdx) : "";
  const baseTrimmed = base.replace(/\/+$/, "");
  const subTrimmed = subPath.replace(/^\/+/, "");
  return `${baseTrimmed}/${subTrimmed}${query}`;
}

// Error codes from agnicFetch that should NEVER trigger an LLM fallback —
// they're payment/transport problems, not input-shape problems.
// KNOWN GAP (deferred — needs a cassette re-record): agnicFetch normalizes
// upstream messages via rawCode.toLowerCase().replace(/[\s-]+/g, "_"), so
// "Payment exceeds maximum allowed value" becomes
// `payment_exceeds_maximum_allowed_value` — this `payment_exceeds_max` entry
// never matches it, so a cap error wastefully falls through to an LLM-fallback
// call. The fix is a one-line add, but it changes the replay call sequence
// (a recorded cap error currently triggers that fallback), so landing it
// requires `cassette:record`. Tracked as a follow-up.
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

// Canonical receipt error code for a failed call. Rate-limit failures (which
// agnicFetch may surface as "upstream_429" etc.) collapse to "rate_limited" so
// the UI can render them honestly instead of as a misleading "timeout".
function callErrorCode(e: unknown, fallback: string): string {
  if (e instanceof AgnicFetchError) {
    return isRateLimitError(e) ? "rate_limited" : e.code;
  }
  return fallback;
}

const RATE_LIMIT_BACKOFF_MS = 5_000;

// maxValue headroom (W0.11). The per-call budget cap was pinned to the EXACT
// stored price, so any upstream price drift → payment_exceeds_max (a HARD error,
// no retry). We send a small buffer over the stored price so a modest increase
// is absorbed, while a hard CEILING (shared with the vetter's PRICE_CEILING)
// keeps spend bounded. The vetter reconciles the stored price on its next run.
const MAXVALUE_CEILING_USDC = 0.10;
const DEFAULT_MAXVALUE_BUFFER = 1.5;

// Effective per-call maxValue = min(price × buffer, ceiling). Buffer is
// overridable via INVOKE_MAXVALUE_BUFFER (default 1.5); a non-numeric/empty
// value falls back to the default. The ceiling always wins so a single call can
// never authorize more than $0.10 regardless of buffer or stored price.
export function maxValueForPrice(priceUsdc: number): number {
  const raw = Deno.env.get("INVOKE_MAXVALUE_BUFFER");
  const parsed = raw != null ? Number(raw) : NaN;
  const buffer = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAXVALUE_BUFFER;
  return Math.min(priceUsdc * buffer, MAXVALUE_CEILING_USDC);
}

// Per-call controls threaded from the fan-out: `signal` lets the per-call
// timeout actually abort the in-flight fetch (instead of leaving it running),
// and `timeoutMs` bounds each individual attempt at the agnicFetch layer so a
// slow call surfaces a real "timeout" error code rather than relying solely on
// the outer race.
export interface CallOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

// setTimeout that rejects early if the signal aborts, so a per-call timeout
// firing during the rate-limit backoff unwinds immediately instead of sleeping
// out the full 5s after the work has already been abandoned.
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function performCall(
  built: BuiltCall,
  priceUsdc: number,
  callOpts: CallOpts = {},
): Promise<{
  data: unknown;
  amountUsdc: number;
  paid: boolean;
  network: string | null;
}> {
  const result = await agnicFetch(built.url, {
    method: built.method,
    body: built.method === "POST" ? built.body : undefined,
    maxValueUsd: maxValueForPrice(priceUsdc),
    signal: callOpts.signal,
    timeoutMs: callOpts.timeoutMs,
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
  callOpts: CallOpts = {},
): Promise<Awaited<ReturnType<typeof performCall>>> {
  try {
    return await performCall(built, priceUsdc, callOpts);
  } catch (e) {
    if (e instanceof AgnicFetchError && isRateLimitError(e)) {
      log.warn(
        `[invoke] ${resource} rate-limited; backing off ${RATE_LIMIT_BACKOFF_MS}ms before retry`,
      );
      await abortableSleep(RATE_LIMIT_BACKOFF_MS, callOpts.signal);
      return await performCall(built, priceUsdc, callOpts);
    }
    throw e;
  }
}

function errorOutcome(
  service: RankedService,
  message: string,
  start: number,
  adapterPath: "pattern" | "pattern+subpath" | "llm",
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
  adapterPath: "pattern" | "pattern+subpath" | "llm",
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
  opts: { llm?: LlmClient; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ServiceInvocationOutcome> {
  const llm = opts.llm ?? defaultLlm;
  const callOpts: CallOpts = { signal: opts.signal, timeoutMs: opts.timeoutMs };
  const start = Date.now();

  // DEV-ONLY stress hook: when FORCE_LLM_ADAPTER=true, skip Layer 1 entirely
  // so we can exercise the LLM-built call path + URL-rewrite validator on
  // real production traffic. Production runs should leave this unset.
  if (Deno.env.get("FORCE_LLM_ADAPTER") === "true") {
    log.warn(
      `[invoke] FORCE_LLM_ADAPTER=true — skipping pattern adapter for ${service.resource}`,
    );
    return await invokeViaLlmOnly(
      service,
      address,
      chain,
      llm,
      start,
      callOpts,
    );
  }

  // Layer 1: pattern-match adapter — try the primary shape, then any
  // fallback shapes for POST endpoints.
  let callSet;
  try {
    callSet = buildCallSetFromInfo(service, address, chain);
  } catch (e) {
    const code = e instanceof AdapterFailedError &&
        e.reason.startsWith("unsubstituted_path_param")
      ? "unsubstituted_path_param"
      : "adapter_build_failed";
    return errorOutcome(
      service,
      `pattern-adapter: ${(e as Error).message}`,
      start,
      "pattern",
      code,
    );
  }

  const patternShapes: BuiltCall[] = [callSet.primary, ...callSet.fallbacks];
  let lastError: unknown = null;
  for (let i = 0; i < patternShapes.length; i++) {
    const built = patternShapes[i];
    try {
      const r = await performCallWithRateLimitRetry(
        built,
        service.priceUsdc,
        service.resource,
        callOpts,
      );
      if (i > 0) {
        log.warn(
          `[invoke] ${service.resource} succeeded with fallback POST shape ${i} (body=${
            JSON.stringify(built.body).slice(0, 80)
          })`,
        );
      }
      // Service-descriptor detection: some catalogs publish only the base URL
      // (e.g. orbisapi), and hitting it returns a descriptor like
      // `{name, endpoints: ["/label", "/openapi"]}` instead of address data.
      // Detect that and retry once against the first action sub-endpoint.
      const descriptor = isServiceDescriptor(r.data);
      if (descriptor) {
        return await handleDescriptorResponse(
          service,
          built,
          descriptor.endpoints,
          start,
          callOpts,
        );
      }
      return okOutcome(service, r, start, "ok", "pattern");
    } catch (e) {
      lastError = e;
      // The per-call timeout aborted this attempt — don't burn an LLM-fallback
      // call (and its spend) on work we've already abandoned. Surface a timeout
      // outcome; the outer race has already settled this service anyway.
      if (isAbortError(e)) {
        return errorOutcome(
          service,
          "per-call timeout aborted the request",
          start,
          "pattern",
          "timeout",
        );
      }
      // Hard errors short-circuit — no point trying more pattern shapes.
      if (e instanceof AgnicFetchError && !isUpstreamInputError(e)) {
        return errorOutcome(
          service,
          e.message,
          start,
          "pattern",
          callErrorCode(e, e.code),
        );
      }
      // Otherwise continue to next shape (if any).
    }
  }

  // Layer 2: LLM-built call. Skip if the per-call budget already elapsed.
  if (callOpts.signal?.aborted) {
    return errorOutcome(
      service,
      "per-call timeout aborted before LLM fallback",
      start,
      "pattern",
      "timeout",
    );
  }
  log.warn(
    `[invoke] pattern-match failed for ${service.resource} (${patternShapes.length} shape(s) tried) — trying LLM fallback (${
      (lastError as Error)?.message
    })`,
  );
  return await invokeViaLlmOnly(service, address, chain, llm, start, callOpts);
}

async function invokeViaLlmOnly(
  service: RankedService,
  address: string,
  chain: Chain,
  llm: LlmClient,
  start: number,
  callOpts: CallOpts = {},
): Promise<ServiceInvocationOutcome> {
  let llmBuilt: BuiltCall;
  try {
    llmBuilt = await buildCallFromInfoViaLlm(service, address, chain, llm);
  } catch (lerr) {
    const reason = lerr instanceof AdapterFailedError
      ? lerr.message
      : (lerr as Error).message;
    const code = lerr instanceof AdapterFailedError &&
        lerr.reason.startsWith("unsubstituted_path_param")
      ? "unsubstituted_path_param"
      : "adapter_llm_build_failed";
    log.error(
      `[invoke] both adapters failed for ${service.resource}: ${reason}`,
    );
    return errorOutcome(service, reason, start, "llm", code);
  }

  try {
    const r = await performCallWithRateLimitRetry(
      llmBuilt,
      service.priceUsdc,
      service.resource,
      callOpts,
    );
    return okOutcome(service, r, start, "fallback_ok", "llm");
  } catch (e2) {
    const msg = (e2 as Error).message;
    const code = callErrorCode(e2, "adapter_call_failed");
    log.error(
      `[invoke] both adapters failed for ${service.resource}: ${msg}`,
    );
    return errorOutcome(service, msg, start, "llm", code);
  }
}

// Called after a successful pattern call whose response shape matched the
// service-descriptor heuristic (`{endpoints: string[]}`). Picks the first
// action sub-endpoint (category-hinted), retries once against
// `${baseUrl}/{subPath}`, and returns the retry's outcome. Does NOT fall
// through to the LLM adapter — its URL validator forbids path drift, so it
// can't help with this failure mode.
async function handleDescriptorResponse(
  service: RankedService,
  built: BuiltCall,
  endpoints: string[],
  start: number,
  callOpts: CallOpts = {},
): Promise<ServiceInvocationOutcome> {
  const action = pickActionEndpoint(endpoints, service.category);
  if (!action) {
    log.warn(
      `[invoke] ${service.resource} returned descriptor with no action endpoint; endpoints=${
        JSON.stringify(endpoints)
      }`,
    );
    return errorOutcome(
      service,
      `service returned descriptor with no action endpoint (endpoints=${
        JSON.stringify(endpoints)
      })`,
      start,
      "pattern+subpath",
      "descriptor_only_response",
    );
  }

  const retryUrl = appendSubPath(built.url, action);
  try {
    assertNoUnsubstitutedPlaceholders(retryUrl);
  } catch (e) {
    const msg = (e as Error).message;
    log.warn(
      `[invoke] ${service.resource} descriptor sub-path ${action} reintroduced an unsubstituted placeholder: ${msg}`,
    );
    return errorOutcome(
      service,
      msg,
      start,
      "pattern+subpath",
      "unsubstituted_path_param",
    );
  }
  const retryCall: BuiltCall = built.method === "POST"
    ? { url: retryUrl, method: "POST", body: built.body }
    : { url: retryUrl, method: "GET" };

  log.warn(
    `[invoke] ${service.resource} returned descriptor — retrying against sub-path ${action}`,
  );

  let r: Awaited<ReturnType<typeof performCall>>;
  try {
    r = await performCallWithRateLimitRetry(
      retryCall,
      service.priceUsdc,
      service.resource,
      callOpts,
    );
  } catch (e) {
    const msg = (e as Error).message;
    const code = callErrorCode(e, "descriptor_retry_failed");
    log.warn(
      `[invoke] ${service.resource} descriptor sub-path retry (${action}) failed: ${msg}`,
    );
    return errorOutcome(service, msg, start, "pattern+subpath", code);
  }

  const stillDescriptor = isServiceDescriptor(r.data);
  if (stillDescriptor) {
    log.warn(
      `[invoke] ${service.resource} sub-path ${action} also returned descriptor; endpoints=${
        JSON.stringify(stillDescriptor.endpoints)
      }`,
    );
    return errorOutcome(
      service,
      `descriptor still returned after sub-path retry (sub-path=${action})`,
      start,
      "pattern+subpath",
      "descriptor_only_response",
    );
  }

  return okOutcome(service, r, start, "ok", "pattern+subpath");
}
