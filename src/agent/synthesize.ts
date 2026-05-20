import type { RiskReport } from "../dag/types.ts";
import { RiskReportSchema } from "../dag/types.ts";
import { defaultLlm, type LlmClient } from "./llm.ts";
import type { AgentCtx } from "./types.ts";

export async function llmSynthesize(
  ctx: AgentCtx,
  llm: LlmClient = defaultLlm,
): Promise<RiskReport> {
  const prompt = `
You are a wallet risk-analysis agent. Given the following on-chain and off-chain signals,
produce a structured risk report for the wallet address ${ctx.address} on chain ${ctx.chain}.

Plan rationale: ${ctx.plan?.rationale ?? "(no plan recorded)"}

Findings (some categories may be missing — note coverage gaps in summary):
${JSON.stringify(ctx.findings, null, 2)}

Spend so far: ${ctx.spent} USDC across ${ctx.receipts.length} calls.

Rules:
- riskScore 0 = completely safe, 100 = definitely malicious
- Set sanctioned=true only if findings.sanctions.matchedLists is non-empty
- recommendation must be "proceed" (riskScore <30), "caution" (30-69), or "block" (>=70)
- Keep summary under 100 words
- If some categories are missing, mention coverage gaps in the summary
- generatedAt must be an ISO 8601 timestamp
`.trim();

  return await llm.generateStructured(RiskReportSchema, prompt);
}
