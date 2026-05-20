import { z } from "zod";
import type { Chain } from "../dag/types.ts";

export const CategorySchema = z.enum([
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
  "ens",
  "contract_analysis",
]);
export type Category = z.infer<typeof CategorySchema>;

export const EarlyStopSchema = z.object({
  onSanctionHit: z.boolean(),
  onConfirmedSafeLabel: z.boolean(),
  budgetExhausted: z.boolean(),
});

export const PlanSchema = z.object({
  categories: z.array(CategorySchema).min(1),
  rationale: z.string(),
  earlyStop: EarlyStopSchema,
}).describe("Plan");
export type Plan = z.infer<typeof PlanSchema>;

export interface Call {
  category: Category;
  provider: string;
  endpoint: string;
  estimatedCostUsdc: number;
  phase: 1 | 2;
}

export interface Receipt {
  callId: string;
  amountUsdc: number;
  txHash?: string;
  durationMs: number;
  status: "ok" | "error" | "timeout" | "skipped_budget";
  error?: string;
}

export interface AgentCtx {
  address: string;
  chain: Chain;
  spent: number;
  receipts: Receipt[];
  findings: Partial<Record<Category, unknown>>;
  plan?: Plan;
}
