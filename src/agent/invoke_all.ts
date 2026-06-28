import {
  invokeRankedService,
  type ServiceInvocationOutcome,
} from "./invoke_service.ts";
import { log } from "../observability/log.ts";
import type {
  DiscoveryPlan,
  RankedService,
  WalletNetwork,
} from "../discovery/types.ts";
import {
  recordEmptyOnRich,
  recordError,
  recordOk,
  resetEmptyOnRich,
} from "../discovery/health_store.ts";
import { fetchOnchainHistory } from "./onchain_viem.ts";
import type { LlmClient } from "./llm.ts";
import type { Category, Chain } from "./types.ts";
import { type EventEmitter, now, safeEmit } from "./events.ts";
import { recordServiceObservation } from "../observability/observations.ts";

// 2s was below the observed median x402 RTT (most services finish in 2–4s) and
// produced near-100% per-call timeouts. 5s helped but some services still need
// longer to return real data; we'd rather wait and get the signal than force a
// timeout, so the default is 10s. This still caps how long a hung host can
// dominate the parallel fan-out budget (the 60s agnicFetch gateway timeout is
// the outer backstop). `INVOKE_TIMEOUT_MS` env still overrides for ops; a
// per-request knob is deferred until W1.1 tenant auth lands so it can be
// gated/abuse-capped.
const DEFAULT_INVOKE_TIMEOUT_MS = parseInt(
  Deno.env.get("INVOKE_TIMEOUT_MS") ?? "10000",
  10,
);

// Low-signal categories whose failure is expected and must never block a
// verdict. They run on a shorter per-call budget and surface as a non-blocking
// "skipped · best-effort" rather than a hard error. web_sentiment is general
// crypto-news sentiment that doesn't even take the wallet address, so a slow
// upstream there shouldn't cost the deep path its full per-call budget.
export const BEST_EFFORT_CATEGORIES: ReadonlySet<Category> = new Set<Category>([
  "web_sentiment",
]);
const BEST_EFFORT_TIMEOUT_MS = 6_000;

// Cap concurrent calls to the same host. orbisapi serves labels +
// onchain_history + web_sentiment; firing all three at once self-inflicts 429s
// (and the resulting backoff masquerades as a timeout). A cap of 2 (not 1)
// stops the rate-limiting while keeping two of the three overlapping, so the
// fan-out does NOT serialize into a slow chain.
const PER_HOST_CONCURRENCY = 2;

// The per-call budget (above) bounds a SINGLE agnicFetch attempt. The outer
// race in withInvokeTimeout is only a backstop for a fully hung invoker (e.g.
// the LLM-fallback build call, which has no timeout of its own); size it to
// cover one rate-limit backoff + retry so a legitimately retried call settles
// with its real error code instead of a misleading "timeout".
const RATE_LIMIT_BACKOFF_MS = 5_000;
function backstopMs(perAttemptMs: number): number {
  return perAttemptMs * 2 + RATE_LIMIT_BACKOFF_MS + 1_000;
}

// Per-host counting semaphore. acquire() resolves when a slot is free; release()
// hands a freed slot directly to the next waiter (FIFO) or returns it to the
// pool. Scoped per invokeAll call so it never leaks across requests.
function createHostLimiter(limit: number) {
  const available = new Map<string, number>();
  const waiters = new Map<string, Array<() => void>>();
  const slotsFor = (host: string) =>
    available.has(host) ? available.get(host)! : limit;
  return {
    acquire(host: string): Promise<void> {
      const free = slotsFor(host);
      if (free > 0) {
        available.set(host, free - 1);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const q = waiters.get(host) ?? [];
        q.push(resolve);
        waiters.set(host, q);
      });
    },
    release(host: string): void {
      const q = waiters.get(host);
      if (q && q.length > 0) {
        q.shift()!();
        return;
      }
      available.set(host, Math.min(limit, slotsFor(host) + 1));
    },
  };
}
type HostLimiter = ReturnType<typeof createHostLimiter>;

function withInvokeTimeout(
  promise: Promise<ServiceInvocationOutcome>,
  timeoutMs: number,
  svc: RankedService,
  onTimeout?: () => void,
): Promise<ServiceInvocationOutcome> {
  let timerId: ReturnType<typeof setTimeout>;
  const timeoutP = new Promise<ServiceInvocationOutcome>((resolve) => {
    timerId = setTimeout(
      () => {
        // Abort the in-flight fetch so a hung host doesn't keep a connection
        // (and event-loop work) alive after we've stopped waiting on it.
        onTimeout?.();
        resolve({
          category: svc.category,
          resource: svc.resource,
          data: null,
          status: "error",
          error: `per-call timeout after ${timeoutMs}ms`,
          // Matches the normalized code agnicFetch emits for transport-level
          // timeouts so recordError() persists "timeout" in
          // service_health_durable.last_error_code instead of undefined.
          errorCode: "timeout",
          amountUsdc: 0,
          durationMs: timeoutMs,
          paid: false,
          network: null,
          adapterPath: "pattern",
        });
      },
      timeoutMs,
    );
  });
  // When the invoker settles first, clear the pending timer so it doesn't
  // register as a leaked async resource in Deno's test runner.
  return Promise.race([
    promise.finally(() => clearTimeout(timerId!)),
    timeoutP,
  ]);
}

const VIEM_SUPPORTED_CHAINS: Chain[] = [
  "eth",
  "base",
  "polygon",
  "arbitrum",
  "optimism",
];

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

// Heuristic: does the on-chain history finding indicate a well-known wallet
// that any reasonable labeler should have heard of? Used to gate the
// quality-probe demotion — a labeler returning empty on a brand-new wallet is
// not evidence of weak coverage, only on rich-history ones.
const RICH_HISTORY_TX_COUNT = 100;

function isRichHistory(history: unknown): boolean {
  if (!history || typeof history !== "object") return false;
  const obj = history as Record<string, unknown>;
  const candidates = [obj.txCount, obj.transactionCount, obj.tx_count]
    .filter((v) => typeof v === "number") as number[];
  if (candidates.length === 0) return false;
  return candidates.some((n) => n >= RICH_HISTORY_TX_COUNT);
}

// Description keywords that a meaningful label response should contain — same
// shape as the rerank entity-attribution hint, plus the negative-signal words
// the synthesis policy looks at. If a stringified response contains none of
// these AND is small (< 200 chars of meaningful payload), we call it
// "empty / unattributed" for quality-probe purposes.
const LABEL_PAYLOAD_KEYWORDS = [
  "exchange",
  "binance",
  "coinbase",
  "kraken",
  "bybit",
  "okx",
  "bitfinex",
  "huobi",
  "scam",
  "mixer",
  "tumbler",
  "phisher",
  "phishing",
  "rugpull",
  "fraud",
  "hack",
  "exploit",
  "darknet",
  "stolen",
  "verified",
  "protocol",
  "dao",
  "foundation",
  "entity",
  "name_tag",
  "name tag",
  "cluster",
  "known_safe",
  "attestation",
];

function isEmptyAttribution(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  const stringified = JSON.stringify(data).toLowerCase();
  // Trivially-empty container shapes — {}, [], { tags: [] }, etc.
  if (stringified.length < 30) return true;
  for (const kw of LABEL_PAYLOAD_KEYWORDS) {
    if (stringified.includes(kw)) return false;
  }
  return true;
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
    opts: { llm?: LlmClient; signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<ServiceInvocationOutcome>;
  // Optional viem-onchain override for tests. Default: real fetchOnchainHistory.
  onchainViemFetcher?: typeof fetchOnchainHistory;
  // Disable the viem fallback entirely (used in some tests).
  disableViemFallback?: boolean;
  onEvent?: EventEmitter;
  request_id?: string;
  // Per-call timeout in ms. Defaults to INVOKE_TIMEOUT_MS env (5000ms).
  timeoutMs?: number;
}

async function invokeWithAlternates(
  primary: RankedService,
  alternates: RankedService[],
  address: string,
  chain: Chain,
  invoker: NonNullable<InvokeAllOpts["invoker"]>,
  hostLimiter: HostLimiter,
  llm?: LlmClient,
  emit?: EventEmitter,
  request_id = "",
  timeoutMs = DEFAULT_INVOKE_TIMEOUT_MS,
): Promise<ServiceInvocationOutcome> {
  const candidates = [
    primary,
    ...alternates.slice(0, MAX_ALTERNATES_PER_CATEGORY),
  ];
  // Best-effort categories get a shorter per-call budget so a slow upstream
  // there can't dominate the deep-path fan-out; their failure is non-blocking.
  const perAttemptMs = BEST_EFFORT_CATEGORIES.has(primary.category)
    ? Math.min(timeoutMs, BEST_EFFORT_TIMEOUT_MS)
    : timeoutMs;
  const failedHosts = new Set<string>();
  let lastOutcome: ServiceInvocationOutcome | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const svc = candidates[i];
    const host = hostOf(svc.resource);
    if (failedHosts.has(host)) {
      log.warn(
        `[invoke] skipping ${svc.resource} — host ${host} already failed with domain-level error`,
      );
      continue;
    }
    const svcStart = Date.now();
    safeEmit(emit, {
      type: "service",
      status: "start",
      category: svc.category,
      resource: svc.resource,
      priceUsdc: svc.priceUsdc,
      request_id,
      duration_ms: 0,
      cost_usd: null,
      at: now(),
    });
    // Cap concurrency to this candidate's host so same-host siblings don't
    // 429 each other. Released in finally so a thrown/timed-out call can't
    // leak the slot.
    await hostLimiter.acquire(host);
    let outcome: ServiceInvocationOutcome;
    try {
      const controller = new AbortController();
      outcome = await withInvokeTimeout(
        invoker(svc, address, chain, {
          llm,
          signal: controller.signal,
          timeoutMs: perAttemptMs,
        }),
        backstopMs(perAttemptMs),
        svc,
        () => controller.abort(),
      );
    } finally {
      hostLimiter.release(host);
    }
    // Update health stats so future rerank calls can weight this service.
    if (outcome.status === "ok" || outcome.status === "fallback_ok") {
      await recordOk(svc.resource);
      if (i > 0) {
        log.warn(
          `[invoke] primary failed for ${primary.category}; succeeded on alternate ${svc.resource}`,
        );
      }
      const okEvent = {
        type: "service" as const,
        status: "ok" as const,
        category: svc.category,
        resource: svc.resource,
        priceUsdc: svc.priceUsdc,
        amountUsdc: outcome.amountUsdc,
        request_id,
        duration_ms: outcome.durationMs ?? (Date.now() - svcStart),
        cost_usd: outcome.paid ? outcome.amountUsdc : null,
        at: now(),
      };
      safeEmit(emit, okEvent);
      recordServiceObservation(okEvent);
      return outcome;
    }
    await recordError(
      svc.resource,
      outcome.error ?? "(unknown)",
      outcome.errorCode,
    );
    lastOutcome = outcome;
    if (isDomainLevelError(outcome.error)) {
      failedHosts.add(host);
    }
    const hasNextCandidate = i < candidates.length - 1;
    const failEvent = {
      type: "service" as const,
      status: (hasNextCandidate ? "fallback" : "error") as "fallback" | "error",
      category: svc.category,
      resource: svc.resource,
      priceUsdc: svc.priceUsdc,
      request_id,
      duration_ms: outcome.durationMs ?? (Date.now() - svcStart),
      cost_usd: null as null,
      error: outcome.error,
      at: now(),
    };
    safeEmit(emit, failEvent);
    recordServiceObservation(failEvent);
    if (hasNextCandidate) {
      log.warn(
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
  const viemFetcher = opts.onchainViemFetcher ?? fetchOnchainHistory;
  const viemEnabled = !opts.disableViemFallback;
  const emit = opts.onEvent;
  const request_id = opts.request_id ?? "";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
  // Shared across the whole fan-out so same-host calls (e.g. orbisapi labels +
  // onchain_history + web_sentiment) cap at PER_HOST_CONCURRENCY together.
  const hostLimiter = createHostLimiter(PER_HOST_CONCURRENCY);

  const outcomes = await Promise.all(
    plan.services.map((s) =>
      invokeWithAlternates(
        s,
        plan.alternates[s.category] ?? [],
        plan.address,
        chain,
        invoker,
        hostLimiter,
        opts.llm,
        emit,
        request_id,
        timeoutMs,
      )
    ),
  );

  // Viem fallback for onchain_history when the x402 attempt fully failed.
  if (viemEnabled && VIEM_SUPPORTED_CHAINS.includes(chain)) {
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      if (o.category !== "onchain_history" || o.status !== "error") continue;
      const viemResource = `viem://${chain}`;
      const viemStart = Date.now();
      safeEmit(emit, {
        type: "service",
        status: "start",
        category: "onchain_history",
        resource: viemResource,
        kind: "direct",
        priceUsdc: 0,
        request_id,
        duration_ms: 0,
        cost_usd: null,
        at: now(),
      });
      try {
        const viemData = await viemFetcher(plan.address, chain);
        const durationMs = Date.now() - viemStart;
        log.warn(
          `[invoke] onchain_history x402 failed; viem fallback succeeded (txCount=${viemData.txCount}, balanceEth=${
            viemData.balanceEth.toFixed(4)
          })`,
        );
        outcomes[i] = {
          category: "onchain_history",
          resource: viemResource,
          data: viemData,
          status: "fallback_ok",
          amountUsdc: 0,
          durationMs,
          paid: false,
          network: chain,
          // We use the existing "llm" adapter path slot for viem so the
          // serializer doesn't need a schema change — viem rescue is rare
          // enough that this overload is acceptable.
          adapterPath: "llm",
        };
        const viemOkEvent = {
          type: "service" as const,
          status: "ok" as const,
          category: "onchain_history" as const,
          resource: viemResource,
          kind: "direct" as const,
          priceUsdc: 0,
          amountUsdc: 0,
          request_id,
          duration_ms: durationMs,
          cost_usd: null as null,
          at: now(),
        };
        safeEmit(emit, viemOkEvent);
        recordServiceObservation(viemOkEvent);
      } catch (e) {
        const msg = (e as Error).message;
        log.warn(
          `[invoke] viem fallback for onchain_history failed: ${msg}`,
        );
        const viemErrEvent = {
          type: "service" as const,
          status: "error" as const,
          category: "onchain_history" as const,
          resource: viemResource,
          kind: "direct" as const,
          priceUsdc: 0,
          request_id,
          duration_ms: Date.now() - viemStart,
          cost_usd: null as null,
          error: msg,
          at: now(),
        };
        safeEmit(emit, viemErrEvent);
        recordServiceObservation(viemErrEvent);
        // Leave the error outcome in place — coverage gap surfaces in synth.
      }
    }
  }

  // Quality probe: if onchain_history says the wallet is rich (well-known) and
  // the labels call came back empty/unattributed, record that as a quality
  // miss. Persistent misses durably demote the labeler in subsequent rerank.
  // See health_store.recordEmptyOnRich / isQualityDemoted for the policy.
  const historyOutcome = outcomes.find((o) => o.category === "onchain_history");
  const labelsOutcome = outcomes.find((o) => o.category === "labels");
  if (
    historyOutcome &&
    (historyOutcome.status === "ok" ||
      historyOutcome.status === "fallback_ok") &&
    isRichHistory(historyOutcome.data) &&
    labelsOutcome &&
    (labelsOutcome.status === "ok" || labelsOutcome.status === "fallback_ok")
  ) {
    if (isEmptyAttribution(labelsOutcome.data)) {
      log.warn(
        `[invoke] labels service ${labelsOutcome.resource} returned empty attribution on rich-history wallet — recording quality miss`,
      );
      await recordEmptyOnRich(labelsOutcome.resource);
    } else {
      await resetEmptyOnRich(labelsOutcome.resource);
    }
  }

  // Fail-fast on sanctions error.
  const sanctionsOutcome = outcomes.find((o) => o.category === "sanctions");
  if (sanctionsOutcome) {
    if (sanctionsOutcome.status === "error") {
      throw new SanctionsInvocationError(
        sanctionsOutcome.error ?? "(unknown)",
      );
    }
  } else {
    log.warn(
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
