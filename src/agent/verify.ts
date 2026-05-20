import type { RiskReport, VerifyRequest } from "../dag/types.ts";
import { defaultLlm, type LlmClient } from "./llm.ts";
import type { AgentCtx } from "./types.ts";
import { llmPlan } from "./plan.ts";
import { resolveBazaarEndpoints } from "./resolve.ts";
import { phaseGroups } from "./phases.ts";
import { budgetedCall } from "./budgeted_call.ts";
import { mergeResults } from "./merge.ts";
import { shouldStopEarly } from "./stop.ts";
import { llmSynthesize } from "./synthesize.ts";

export async function verifyAgent(
  req: VerifyRequest,
  opts: { budgetCeiling: number; llm?: LlmClient } = { budgetCeiling: 0.05 },
): Promise<{ report: RiskReport; ctx: AgentCtx }> {
  const { budgetCeiling, llm = defaultLlm } = opts;

  const ctx: AgentCtx = {
    address: req.address,
    chain: req.chain,
    spent: 0,
    receipts: [],
    findings: {},
  };

  const plan = await llmPlan(req.address, req.chain, llm);
  ctx.plan = plan;

  const calls = resolveBazaarEndpoints(plan.categories, req.chain);
  const phases = phaseGroups(calls);

  for (const phase of phases) {
    const outcomes = await Promise.allSettled(
      phase.map((call) => budgetedCall(call, ctx, budgetCeiling)),
    );
    mergeResults(ctx, outcomes);

    if (shouldStopEarly(ctx, plan.earlyStop, budgetCeiling)) {
      break;
    }
  }

  const report = await llmSynthesize(ctx, llm);
  return { report, ctx };
}
