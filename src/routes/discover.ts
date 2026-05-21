import { Hono } from "hono";
import { zValidator } from "hono/zod-validator";
import { z } from "zod";
import { CategorySchema, type Category } from "../agent/types.ts";
import { discover } from "../discovery/discover.ts";
import { WalletUnfundedError, DiscoveryFetchError } from "../discovery/types.ts";

const DEFAULT_CATEGORIES: Category[] = [
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
  "contract_analysis",
];

const discoverBodySchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid EVM address"),
  categories: z.array(CategorySchema).min(1).optional(),
});

export const discoverRouter = new Hono();

discoverRouter.post(
  "/",
  zValidator("json", discoverBodySchema),
  async (c) => {
    const { address, categories } = c.req.valid("json");
    const cats = categories ?? DEFAULT_CATEGORIES;

    try {
      const plan = await discover(address, cats);
      return c.json(plan, 200);
    } catch (e) {
      if (e instanceof WalletUnfundedError) {
        return c.json({
          error: "wallet_unfunded",
          message: e.message,
          baseAddress: e.baseAddress,
          baseSepoliaAddress: e.baseSepoliaAddress,
        }, 402);
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
