import type { Chain } from "../dag/types.ts";
import { defaultLlm, type LlmClient } from "./llm.ts";
import { type Plan, PlanSchema } from "./types.ts";

export async function llmPlan(
  address: string,
  chain: Chain,
  llm: LlmClient = defaultLlm,
): Promise<Plan> {
  const prompt = `
You are planning a wallet risk-verification run for address ${address} on chain ${chain}.

Choose which signal categories to fetch. Available categories:
- sanctions     — OFAC/SDN screening (cheap, always run for unknown addrs)
- labels        — Nansen/Etherscan-style entity labels (cheap, can short-circuit)
- onchain_history — tx count, age, volume (medium cost)
- web_sentiment — news/social mentions (medium cost)
- ens           — ENS reverse lookup (free)
- contract_analysis — only if address is a contract (expensive)

Rules:
- Pick the minimum set that justifies a confident risk score.
- Always include sanctions and labels unless you have strong reason not to.
- Set earlyStop flags so the harness can exit on definitive signals.
`.trim();
  return await llm.generateStructured(PlanSchema, prompt);
}
