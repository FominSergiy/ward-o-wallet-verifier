import { Hono } from "hono";
import { zValidator } from "hono/zod-validator";
import { z } from "zod";
import { type Category, CategorySchema, ChainSchema } from "../agent/types.ts";
import { discover } from "../discovery/discover.ts";
import { invokeAll } from "../agent/invoke_all.ts";
import { jsonErrorBody, mapRouteError } from "./errors.ts";
import { resolveApiKeyId } from "./key_attribution.ts";
import { runWithApiKey } from "../observability/request_context.ts";

const DEFAULT_CATEGORIES: Category[] = [
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
];

const invokeBodySchema = z.object({
  address: z.string().regex(
    /^0x[0-9a-fA-F]{40}$/,
    "Must be a valid EVM address",
  ),
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
    const apiKeyId = await resolveApiKeyId(c);

    try {
      const plan = await discover(address, cats);
      const result = await runWithApiKey(
        apiKeyId,
        () => invokeAll(plan, chain),
      );
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
      const mapped = mapRouteError(e);
      if (mapped) return c.json(jsonErrorBody(mapped), mapped.status);
      throw e;
    }
  },
);
