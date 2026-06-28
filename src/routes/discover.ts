import { Hono } from "hono";
import { zValidator } from "hono/zod-validator";
import { z } from "zod";
import { type Category, CategorySchema } from "../agent/types.ts";
import { discover } from "../discovery/discover.ts";
import { jsonErrorBody, mapRouteError } from "./errors.ts";

const DEFAULT_CATEGORIES: Category[] = [
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
];

const discoverBodySchema = z.object({
  address: z.string().regex(
    /^0x[0-9a-fA-F]{40}$/,
    "Must be a valid EVM address",
  ),
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
      const mapped = mapRouteError(e);
      if (mapped) return c.json(jsonErrorBody(mapped), mapped.status);
      throw e;
    }
  },
);
