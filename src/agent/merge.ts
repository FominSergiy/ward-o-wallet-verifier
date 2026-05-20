import type { AgentCtx, Receipt } from "./types.ts";
import type { CallOutcome } from "./budgeted_call.ts";

export function mergeResults(
  ctx: AgentCtx,
  outcomes: PromiseSettledResult<CallOutcome>[],
): void {
  for (const result of outcomes) {
    let receipt: Receipt;

    if (result.status === "fulfilled") {
      const { call, data, receipt: r } = result.value;
      receipt = r;
      if (r.status === "ok") {
        ctx.findings[call.category] = data;
      }
    } else {
      receipt = {
        callId: "unknown:unknown",
        amountUsdc: 0,
        durationMs: 0,
        status: "error",
        error: String(result.reason),
      };
    }

    ctx.receipts.push(receipt);
    ctx.spent += receipt.amountUsdc;
  }
}
