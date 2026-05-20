import type { AgentCtx, Plan } from "./types.ts";

export const CONFIRMED_SAFE_LABELS = ["binance", "coinbase", "kraken", "okx"] as const;

export function shouldStopEarly(
  ctx: AgentCtx,
  earlyStop: Plan["earlyStop"],
  budgetCeiling: number,
): boolean {
  if (earlyStop.onSanctionHit) {
    const s = ctx.findings.sanctions;
    if (
      typeof s === "object" && s !== null && "sanctioned" in s &&
      (s as Record<string, unknown>).sanctioned === true
    ) {
      return true;
    }
  }

  if (earlyStop.onConfirmedSafeLabel) {
    const l = ctx.findings.labels;
    if (typeof l === "object" && l !== null && "labels" in l) {
      const labels = (l as Record<string, unknown>).labels;
      if (Array.isArray(labels)) {
        const lower = labels.map((x) => String(x).toLowerCase());
        if (CONFIRMED_SAFE_LABELS.some((safe) => lower.includes(safe))) {
          return true;
        }
      }
    }
  }

  if (earlyStop.budgetExhausted && ctx.spent >= 0.99 * budgetCeiling) {
    return true;
  }

  return false;
}
