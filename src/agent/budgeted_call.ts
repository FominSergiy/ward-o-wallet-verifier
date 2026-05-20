import type { Call, Receipt, AgentCtx } from "./types.ts";
import type { VerifyRequest } from "../dag/types.ts";
import { runSanctions } from "../dag/nodes/sanctions.ts";
import { runWebSearch } from "../dag/nodes/web_search.ts";
import { runOnchain } from "../dag/nodes/onchain.ts";
import { runEns } from "../dag/nodes/ens.ts";

export interface CallOutcome {
  call: Call;
  data: unknown | null;
  receipt: Receipt;
}

export type Invoker = (
  call: Call,
  ctx: AgentCtx,
) => Promise<{ data: unknown; amountUsdc: number; txHash?: string }>;

export const defaultInvoker: Invoker = async (call, ctx) => {
  const req: VerifyRequest = { address: ctx.address, chain: ctx.chain };
  switch (call.category) {
    case "sanctions": {
      const r = await runSanctions(req, {});
      return { data: r.data, amountUsdc: call.estimatedCostUsdc };
    }
    case "onchain_history": {
      const r = await runOnchain(req, {});
      return { data: r.data, amountUsdc: call.estimatedCostUsdc };
    }
    case "web_sentiment": {
      const r = await runWebSearch(req, {});
      return { data: r.data, amountUsdc: call.estimatedCostUsdc };
    }
    case "ens": {
      const r = await runEns(req, {});
      return { data: r.data, amountUsdc: call.estimatedCostUsdc };
    }
    case "labels":
      return { data: { labels: [] }, amountUsdc: call.estimatedCostUsdc };
    case "contract_analysis":
      throw new Error("contract_analysis invoker not yet implemented");
    default: {
      const _never: never = call.category;
      throw new Error(`Unknown category: ${_never}`);
    }
  }
};

export async function budgetedCall(
  call: Call,
  ctx: AgentCtx,
  budgetCeiling: number,
  invoker: Invoker = defaultInvoker,
  timeoutMs = 5000,
  backoffsMs: number[] = [200, 800],
): Promise<CallOutcome> {
  const callId = `${call.category}:${call.provider}`;

  if (ctx.spent + call.estimatedCostUsdc > budgetCeiling) {
    return {
      call,
      data: null,
      receipt: { callId, amountUsdc: 0, durationMs: 0, status: "skipped_budget" },
    };
  }

  const start = Date.now();
  let lastError = "";
  const attempts = 1 + backoffsMs.length;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, backoffsMs[attempt - 1]));
    }
    let timerId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      });
      const result = await Promise.race([invoker(call, ctx), timeoutPromise]);
      clearTimeout(timerId);
      return {
        call,
        data: result.data,
        receipt: {
          callId,
          amountUsdc: result.amountUsdc,
          txHash: result.txHash,
          durationMs: Date.now() - start,
          status: "ok",
        },
      };
    } catch (err) {
      clearTimeout(timerId);
      lastError = err instanceof Error ? err.message : String(err);
      if (lastError === "timeout") {
        return {
          call,
          data: null,
          receipt: {
            callId,
            amountUsdc: 0,
            durationMs: Date.now() - start,
            status: "timeout",
            error: "timeout",
          },
        };
      }
    }
  }

  return {
    call,
    data: null,
    receipt: {
      callId,
      amountUsdc: 0,
      durationMs: Date.now() - start,
      status: "error",
      error: lastError,
    },
  };
}
