import { Hono } from "hono";
import { zValidator } from "hono/zod-validator";
import { z } from "zod";
import { VerifyRequestSchema } from "../agent/types.ts";
import { verifyAgent } from "../agent/verify.ts";
import { BEST_EFFORT_CATEGORIES } from "../agent/invoke_all.ts";
import { type AgnicBudget, fetchAgnicBudget } from "../discovery/network.ts";
import { type VerdictCache } from "../agent/verdict_cache.ts";
import { type SanctionedDenylist } from "../agent/sanctioned_denylist.ts";
import { jsonErrorBody, mapRouteError } from "./errors.ts";
import { budgetThreshold } from "./budget.ts";
import { resolveApiKeyId } from "./key_attribution.ts";
import { runWithApiKey } from "../observability/request_context.ts";
import { log } from "../observability/log.ts";

const VerifyAgentRequestSchema = VerifyRequestSchema.extend({
  budgetCeiling: z.number().positive().optional(),
  // "fast" = free sanctions gate only ($0, no x402); "deep" (default) = full
  // pipeline. Omitted → deep, preserving the historical single-tier contract.
  depth: z.enum(["fast", "deep"]).optional(),
});

export interface VerifyAgentRouterOpts {
  /** Test seam for the pre-flight budget fetcher. Defaults to fetchAgnicBudget. */
  budgetFetcher?: () => Promise<AgnicBudget | null>;
  /**
   * Test seam for the verify pipeline. Defaults to the real verifyAgent.
   * Used by hermetic route tests so they can exercise the budget-guard / schema
   * paths without driving the full pipeline into real oracle/x402 network calls.
   */
  verify?: typeof verifyAgent;
  verdictCache?: VerdictCache;
  denylist?: SanctionedDenylist;
}

export function createVerifyAgentRouter(
  opts: VerifyAgentRouterOpts = {},
): Hono {
  const router = new Hono();
  const fetchBudget = opts.budgetFetcher ?? (() => fetchAgnicBudget());
  const runVerify = opts.verify ?? verifyAgent;
  const verdictCache = opts.verdictCache;
  const denylist = opts.denylist;

  router.post("/", zValidator("json", VerifyAgentRequestSchema), async (c) => {
    const { budgetCeiling, depth, ...req } = c.req.valid("json");

    // Pre-flight budget guard. A null result (no key, fetch failure) means
    // we couldn't determine — proceed normally rather than block live traffic
    // on an observability tool.
    const threshold = budgetThreshold();
    try {
      const budget = await fetchBudget();
      if (budget !== null && budget.totalBalance < threshold) {
        return c.json({
          error: "budget_exhausted",
          message: `Agnic budget is below the pre-flight threshold ` +
            `($${budget.totalBalance.toFixed(4)} < $${
              threshold.toFixed(2)
            }). ` +
            `Top up or rotate the API key before retrying.`,
          totalBalance: budget.totalBalance,
          threshold,
        }, 503);
      }
    } catch (e) {
      log.warn(
        `[verify-agent] pre-flight budget check failed (proceeding): ${
          (e as Error).message
        }`,
      );
    }

    // Best-effort attribution: tag this run with the calling key (the web UI's
    // embedded key, or any issued key); anonymous → null. Wraps the pipeline so
    // service_observations rows pick up the id via the ambient context.
    const apiKeyId = await resolveApiKeyId(c);

    try {
      const result = await runWithApiKey(apiKeyId, () =>
        runVerify(req, {
          budgetCeiling,
          depth,
          request_id: crypto.randomUUID(),
          verdictCache,
          denylist,
        }));
      return c.json({
        verdict: result.verdict,
        tier: result.tier,
        fastSignal: result.fastSignal,
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
          bestEffort: BEST_EFFORT_CATEGORIES.has(o.category),
        })),
        walletNetwork: result.walletNetwork,
        totalSpentUsdc: result.totalSpentUsdc,
        totalLlmCostUsd: result.totalLlmCostUsd,
        fromCache: result.fromCache ?? false,
      });
    } catch (e) {
      const mapped = mapRouteError(e);
      if (mapped) return c.json(jsonErrorBody(mapped), mapped.status);
      throw e;
    }
  });

  return router;
}

/** Default export — uses the real fetchAgnicBudget. */
export const verifyAgentRouter = createVerifyAgentRouter();
