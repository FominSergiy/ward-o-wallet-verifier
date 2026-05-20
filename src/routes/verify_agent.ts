import { Hono } from "hono";
import { zValidator } from "hono/zod-validator";
import { z } from "zod";
import { VerifyRequestSchema } from "../dag/types.ts";
import { verifyAgent } from "../agent/verify.ts";

const VerifyAgentRequestSchema = VerifyRequestSchema.extend({
  budgetCeiling: z.number().positive().optional(),
});

const verifyAgentRouter = new Hono();

verifyAgentRouter.post("/", zValidator("json", VerifyAgentRequestSchema), async (c) => {
  const { budgetCeiling, ...req } = c.req.valid("json");
  const { report, ctx } = await verifyAgent(req, { budgetCeiling: budgetCeiling ?? 0.05 });
  return c.json({ report, ctx });
});

export { verifyAgentRouter };
