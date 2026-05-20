import type { AgentCtx, Call, Receipt } from "./types.ts";

// Local re-declaration — must stay in sync with budgeted_call.ts (ticket 4).
// Ticket 8 (orchestrator) will import from one canonical location.
interface CallOutcome {
  call: Call;
  data: unknown | null;
  receipt: Receipt;
}

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
