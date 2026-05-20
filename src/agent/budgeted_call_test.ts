import { assertEquals } from "@std/assert";
import type { Call, AgentCtx } from "./types.ts";
import { budgetedCall, type Invoker } from "./budgeted_call.ts";

function makeCall(overrides: Partial<Call> = {}): Call {
  return {
    category: "sanctions",
    provider: "bazaar/ofac",
    endpoint: "bazaar/ofac",
    estimatedCostUsdc: 0.001,
    phase: 1,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<AgentCtx> = {}): AgentCtx {
  return { address: "0x0", chain: "eth", spent: 0, receipts: [], findings: {}, ...overrides };
}

Deno.test("budgetedCall success", async () => {
  const invoker: Invoker = () => Promise.resolve({ data: { ok: true }, amountUsdc: 0.001 });
  const outcome = await budgetedCall(makeCall(), makeCtx(), 1, invoker);
  assertEquals(outcome.receipt.status, "ok");
  assertEquals(outcome.receipt.amountUsdc, 0.001);
  assertEquals(outcome.receipt.callId, "sanctions:bazaar/ofac");
});

Deno.test("budgetedCall retries 3 times on error", async () => {
  let count = 0;
  const invoker: Invoker = () => {
    count++;
    return Promise.reject(new Error("oops"));
  };
  const outcome = await budgetedCall(makeCall(), makeCtx(), 1, invoker, 5000, [0, 0]);
  assertEquals(outcome.receipt.status, "error");
  assertEquals(outcome.receipt.error, "oops");
  assertEquals(count, 3);
});

Deno.test("budgetedCall timeout", async () => {
  const invoker: Invoker = () => new Promise(() => {});
  const outcome = await budgetedCall(makeCall(), makeCtx(), 1, invoker, 50, []);
  assertEquals(outcome.receipt.status, "timeout");
  assertEquals(outcome.data, null);
});

Deno.test("budgetedCall budget skip", async () => {
  let called = false;
  const invoker: Invoker = () => {
    called = true;
    return Promise.resolve({ data: {}, amountUsdc: 0 });
  };
  const outcome = await budgetedCall(
    makeCall({ estimatedCostUsdc: 0.001 }),
    makeCtx({ spent: 0.05 }),
    0.05,
    invoker,
  );
  assertEquals(outcome.receipt.status, "skipped_budget");
  assertEquals(called, false);
});

Deno.test("budgetedCall retry then succeed", async () => {
  let count = 0;
  const invoker: Invoker = () => {
    count++;
    if (count < 3) return Promise.reject(new Error("fail"));
    return Promise.resolve({ data: { ok: true }, amountUsdc: 0.001 });
  };
  const outcome = await budgetedCall(makeCall(), makeCtx(), 1, invoker, 5000, [0, 0]);
  assertEquals(outcome.receipt.status, "ok");
  assertEquals(count, 3);
});
