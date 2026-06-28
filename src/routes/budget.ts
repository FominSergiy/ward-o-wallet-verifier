const DEFAULT_BUDGET_MIN_USD = 0.10;

/**
 * Pre-flight budget floor (USD) for the verify routes. Reads
 * `AGNIC_BUDGET_MIN_USD`, falling back to the default on unset/invalid values.
 * Shared by /verify-agent and /verify-agent-stream so the two tiers agree.
 */
export function budgetThreshold(): number {
  const raw = Deno.env.get("AGNIC_BUDGET_MIN_USD");
  if (!raw) return DEFAULT_BUDGET_MIN_USD;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_BUDGET_MIN_USD;
}
