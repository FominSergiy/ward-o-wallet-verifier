import { Hono } from "hono";
import { zValidator } from "hono/zod-validator";
import { z } from "zod";
import { ChainSchema } from "../dag/types.ts";
import { CategorySchema, type Category } from "../agent/types.ts";
import { discover } from "../discovery/discover.ts";
import { invokeAll, SanctionsInvocationError } from "../agent/invoke_all.ts";
import {
  DiscoveryFetchError,
  WalletUnfundedError,
} from "../discovery/types.ts";

const DEFAULT_CATEGORIES: Category[] = [
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
  "contract_analysis",
];

const invokeBodySchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid EVM address"),
  chain: ChainSchema,
  categories: z.array(CategorySchema).min(1).optional(),
});

export const invokeRouter = new Hono();

invokeRouter.post(
  "/",
  zValidator("json", invokeBodySchema),
  async (c) => {
    const { address, chain, categories } = c.req.valid("json");
    const cats = categories ?? DEFAULT_CATEGORIES;

    try {
      const plan = await discover(address, cats);
      const result = await invokeAll(plan, chain);
      return c.json({
        address,
        chain,
        walletNetwork: result.walletNetwork,
        findings: result.findings,
        receipts: result.outcomes.map((o) => ({
          category: o.category,
          resource: o.resource,
          status: o.status,
          adapterPath: o.adapterPath,
          amountUsdc: o.amountUsdc,
          durationMs: o.durationMs,
          paid: o.paid,
          network: o.network,
          error: o.error,
        })),
        unresolved: result.unresolved,
        totalSpentUsdc: result.totalSpentUsdc,
        plan: {
          rationale: plan.services.map((s) => ({
            category: s.category,
            resource: s.resource,
            priceUsdc: s.priceUsdc,
            rationale: s.rationale,
          })),
        },
      }, 200);
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
  },
);
