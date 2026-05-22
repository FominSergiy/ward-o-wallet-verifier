import { Hono } from "hono";
import { zValidator } from "hono/zod-validator";
import { z } from "zod";
import { VerifyRequestSchema } from "../agent/types.ts";
import { verifyAgent } from "../agent/verify.ts";
import {
  DiscoveryFetchError,
  WalletUnfundedError,
} from "../discovery/types.ts";
import { SanctionsInvocationError } from "../agent/invoke_all.ts";
import { fetchAgnicBudget, type AgnicBudget } from "../discovery/network.ts";

const VerifyAgentRequestSchema = VerifyRequestSchema.extend({
  budgetCeiling: z.number().positive().optional(),
});

const DEFAULT_BUDGET_MIN_USD = 0.10;

function budgetThreshold(): number {
  const raw = Deno.env.get("AGNIC_BUDGET_MIN_USD");
  if (!raw) return DEFAULT_BUDGET_MIN_USD;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BUDGET_MIN_USD;
}

export interface VerifyAgentRouterOpts {
  /** Test seam for the pre-flight budget fetcher. Defaults to fetchAgnicBudget. */
  budgetFetcher?: () => Promise<AgnicBudget | null>;
}

export function createVerifyAgentRouter(opts: VerifyAgentRouterOpts = {}): Hono {
  const router = new Hono();
  const fetchBudget = opts.budgetFetcher ?? (() => fetchAgnicBudget());

  router.post("/", zValidator("json", VerifyAgentRequestSchema), async (c) => {
    const { budgetCeiling, ...req } = c.req.valid("json");

    // Pre-flight budget guard. A null result (no key, fetch failure) means
    // we couldn't determine — proceed normally rather than block live traffic
    // on an observability tool.
    const threshold = budgetThreshold();
    try {
      const budget = await fetchBudget();
      if (budget !== null && budget.totalBalance < threshold) {
        return c.json({
          error: "budget_exhausted",
          message:
            `Agnic budget is below the pre-flight threshold ` +
            `($${budget.totalBalance.toFixed(4)} < $${threshold.toFixed(2)}). ` +
            `Top up or rotate the API key before retrying.`,
          totalBalance: budget.totalBalance,
          threshold,
        }, 503);
      }
    } catch (e) {
      console.warn(
        `[verify-agent] pre-flight budget check failed (proceeding): ${(e as Error).message}`,
      );
    }

    try {
      const result = await verifyAgent(req, { budgetCeiling });
      return c.json({
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
        })),
        walletNetwork: result.walletNetwork,
        totalSpentUsdc: result.totalSpentUsdc,
      });
    } catch (e) {
      if (e instanceof WalletUnfundedError) {
        return c.json({
          error: "wallet_unfunded",
          message: e.message,
          baseAddress: e.baseAddress,
          baseSepoliaAddress: e.baseSepoliaAddress,
        }, 402);
      }
      if (e instanceof SanctionsInvocationError) {
        return c.json({
          error: "sanctions_invocation_failed",
          message: e.message,
        }, 502);
      }
      if (e instanceof DiscoveryFetchError) {
        return c.json({
          error: "discovery_upstream_failed",
          message: e.message,
          status: e.status,
          url: e.url,
        }, 502);
      }
      if (e instanceof Error && e.message.includes("AGNIC_API_KEY")) {
        return c.json({ error: "missing_config", message: e.message }, 500);
      }
      throw e;
    }
  });

  return router;
}

/** Default export — uses the real fetchAgnicBudget. */
export const verifyAgentRouter = createVerifyAgentRouter();
