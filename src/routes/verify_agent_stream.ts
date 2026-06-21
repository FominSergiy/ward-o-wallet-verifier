import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "hono/zod-validator";
import { z } from "zod";
import { VerifyRequestSchema } from "../agent/types.ts";
import { verifyAgent, type VerifyAgentResult } from "../agent/verify.ts";
import {
  DiscoveryFetchError,
  WalletUnfundedError,
} from "../discovery/types.ts";
import { SanctionsInvocationError } from "../agent/invoke_all.ts";
import { type AgnicBudget, fetchAgnicBudget } from "../discovery/network.ts";
import { type EventEmitter, now, type VerifyEvent } from "../agent/events.ts";
import { type VerdictCache } from "../agent/verdict_cache.ts";
import { type SanctionedDenylist } from "../agent/sanctioned_denylist.ts";

const VerifyAgentStreamRequestSchema = VerifyRequestSchema.extend({
  budgetCeiling: z.number().positive().optional(),
  // "fast" = free sanctions gate only ($0); "deep" (default) = full pipeline.
  depth: z.enum(["fast", "deep"]).optional(),
});

const DEFAULT_BUDGET_MIN_USD = 0.10;
const PING_INTERVAL_MS = 15_000;

function budgetThreshold(): number {
  const raw = Deno.env.get("AGNIC_BUDGET_MIN_USD");
  if (!raw) return DEFAULT_BUDGET_MIN_USD;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_BUDGET_MIN_USD;
}

function resultPayload(result: VerifyAgentResult): Record<string, unknown> {
  return {
    verdict: result.verdict,
    synthesisError: result.synthesisError,
    plan: {
      services: result.plan.services.map((s) => ({
        category: s.category,
        resource: s.resource,
        priceUsdc: s.priceUsdc,
        rationale: s.rationale,
      })),
    },
    receipts: result.outcomes.map((o) => ({
      category: o.category,
      resource: o.resource,
      status: o.status,
      adapterPath: o.adapterPath,
      amountUsdc: o.amountUsdc,
      durationMs: o.durationMs,
      paid: o.paid,
      error: o.error,
      errorCode: o.errorCode,
    })),
    walletNetwork: result.walletNetwork,
    totalSpentUsdc: result.totalSpentUsdc,
    totalLlmCostUsd: result.totalLlmCostUsd,
    tier: result.tier,
    fastSignal: result.fastSignal,
  };
}

export interface VerifyAgentStreamRouterOpts {
  /** Test seam for the pre-flight budget fetcher. Defaults to fetchAgnicBudget. */
  budgetFetcher?: () => Promise<AgnicBudget | null>;
  /** Test seam for the underlying verifyAgent call. */
  verifyAgentFn?: typeof verifyAgent;
  verdictCache?: VerdictCache;
  denylist?: SanctionedDenylist;
}

export function createVerifyAgentStreamRouter(
  opts: VerifyAgentStreamRouterOpts = {},
): Hono {
  const router = new Hono();
  const fetchBudget = opts.budgetFetcher ?? (() => fetchAgnicBudget());
  const verifyFn = opts.verifyAgentFn ?? verifyAgent;
  const verdictCache = opts.verdictCache;
  const denylist = opts.denylist;

  router.post(
    "/",
    zValidator("json", VerifyAgentStreamRequestSchema),
    (c) => {
      const { budgetCeiling, depth, ...req } = c.req.valid("json");

      return streamSSE(c, async (stream) => {
        const queue: VerifyEvent[] = [];
        const wake = { resolve: () => {} } as { resolve: () => void };
        let closed = false;
        let drainSignal: Promise<void> = new Promise((r) => {
          wake.resolve = r;
        });

        const emit: EventEmitter = (e) => {
          queue.push(e);
          const r = wake.resolve;
          drainSignal = new Promise((res) => {
            wake.resolve = res;
          });
          r();
        };

        // Keep-alive ping so intermediate proxies / load balancers don't
        // idle-close the connection during a long-running verify.
        const pinger = setInterval(() => {
          if (closed) return;
          // SSE comment line — invisible to event handlers, keeps socket alive.
          stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        }, PING_INTERVAL_MS);

        const flush = async () => {
          while (queue.length > 0) {
            const e = queue.shift()!;
            await stream.writeSSE({
              event: e.type,
              data: JSON.stringify(e),
            });
          }
        };

        const runVerify = async () => {
          // Pre-flight budget guard. Mirrors /verify-agent — if balance is
          // below threshold, emit one error event and stop. We can't change
          // the HTTP status mid-stream, so the failure mode is in the body.
          const threshold = budgetThreshold();
          try {
            const budget = await fetchBudget();
            if (budget !== null && budget.totalBalance < threshold) {
              emit({
                type: "error",
                code: "budget_exhausted",
                status: 503,
                message: `Agnic budget is below the pre-flight threshold ` +
                  `($${budget.totalBalance.toFixed(4)} < $${
                    threshold.toFixed(2)
                  }). ` +
                  `Top up or rotate the API key before retrying.`,
                at: now(),
              });
              return;
            }
          } catch (e) {
            console.warn(
              `[verify-agent-stream] pre-flight budget check failed (proceeding): ${
                (e as Error).message
              }`,
            );
          }

          try {
            const result = await verifyFn(req, {
              budgetCeiling,
              depth,
              onEvent: emit,
              request_id: crypto.randomUUID(),
              verdictCache,
              denylist,
            });
            emit({ type: "result", payload: resultPayload(result), at: now() });
          } catch (e) {
            if (e instanceof WalletUnfundedError) {
              emit({
                type: "error",
                code: "wallet_unfunded",
                status: 402,
                message: e.message,
                at: now(),
              });
              return;
            }
            if (e instanceof SanctionsInvocationError) {
              emit({
                type: "error",
                code: "sanctions_invocation_failed",
                status: 502,
                message: e.message,
                at: now(),
              });
              return;
            }
            if (e instanceof DiscoveryFetchError) {
              emit({
                type: "error",
                code: "discovery_upstream_failed",
                status: 502,
                message: e.message,
                at: now(),
              });
              return;
            }
            if (e instanceof Error && e.message.includes("AGNIC_API_KEY")) {
              emit({
                type: "error",
                code: "missing_config",
                status: 500,
                message: e.message,
                at: now(),
              });
              return;
            }
            emit({
              type: "error",
              code: "internal_error",
              status: 500,
              message: (e as Error).message ?? "unknown",
              at: now(),
            });
          }
        };

        const verifyPromise = runVerify().finally(() => {
          closed = true;
          // Final wake so the writer loop can exit even if no event landed
          // after the last verify-side emit.
          wake.resolve();
        });

        // Writer loop: drain the queue, wait for the next emit or for the
        // verify run to finish, repeat. This ordering guarantees we keep
        // SSE writes in-order even though emits arrive asynchronously.
        while (!closed || queue.length > 0) {
          await flush();
          if (closed && queue.length === 0) break;
          await drainSignal;
        }

        clearInterval(pinger);
        await verifyPromise;
      });
    },
  );

  return router;
}

/** Default export — uses the real fetchAgnicBudget + verifyAgent. */
export const verifyAgentStreamRouter = createVerifyAgentStreamRouter();
