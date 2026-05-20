import { assertEquals } from "@std/assert";
import type { AgentCtx, Call, Receipt } from "./types.ts";
import { mergeResults } from "./merge.ts";

interface CallOutcome {
  call: Call;
  data: unknown | null;
  receipt: Receipt;
}

function makeCall(category: Call["category"]): Call {
  return { category, provider: "x", endpoint: "x", estimatedCostUsdc: 0, phase: 1 };
}

function makeReceipt(status: Receipt["status"], amountUsdc = 0): Receipt {
  return { callId: "x:x", amountUsdc, durationMs: 0, status };
}

function makeCtx(): AgentCtx {
  return { address: "0x0", chain: "eth", spent: 0, receipts: [], findings: {} };
}

function ok(
  category: Call["category"],
  data: unknown,
  amount = 0,
): PromiseSettledResult<CallOutcome> {
  return {
    status: "fulfilled",
    value: { call: makeCall(category), data, receipt: makeReceipt("ok", amount) },
  };
}

function nonOk(
  category: Call["category"],
  s: Receipt["status"],
): PromiseSettledResult<CallOutcome> {
  return {
    status: "fulfilled",
    value: { call: makeCall(category), data: null, receipt: makeReceipt(s) },
  };
}

function rejected(reason: unknown): PromiseSettledResult<CallOutcome> {
  return { status: "rejected", reason };
}

Deno.test("mergeResults: ok sets finding, non-ok does not", () => {
  const ctx = makeCtx();
  mergeResults(ctx, [
    ok("sanctions", { sanctioned: false }, 0.001),
    nonOk("onchain_history", "timeout"),
    nonOk("ens", "skipped_budget"),
  ]);
  assertEquals(ctx.findings.sanctions !== undefined, true);
  assertEquals(ctx.findings.onchain_history, undefined);
  assertEquals(ctx.findings.ens, undefined);
  assertEquals(ctx.receipts.length, 3);
  assertEquals(ctx.spent, 0.001);
});

Deno.test("mergeResults: single ok sets finding", () => {
  const ctx = makeCtx();
  mergeResults(ctx, [ok("labels", { labels: [] }, 0.0008)]);
  assertEquals(ctx.findings.labels !== undefined, true);
  assertEquals(ctx.spent, 0.0008);
});

Deno.test("mergeResults: rejected creates error receipt", () => {
  const ctx = makeCtx();
  mergeResults(ctx, [rejected("network error")]);
  assertEquals(ctx.receipts.length, 1);
  assertEquals(ctx.receipts[0].status, "error");
  assertEquals(ctx.findings.sanctions, undefined);
  assertEquals(ctx.spent, 0);
});

Deno.test("mergeResults: empty input leaves ctx unchanged", () => {
  const ctx = makeCtx();
  mergeResults(ctx, []);
  assertEquals(ctx.receipts.length, 0);
  assertEquals(ctx.spent, 0);
});
