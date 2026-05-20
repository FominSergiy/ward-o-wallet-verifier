import { assertEquals } from "@std/assert";
import type { AgentCtx, Plan } from "./types.ts";
import { shouldStopEarly } from "./stop.ts";

function makeCtx(overrides: Partial<AgentCtx> = {}): AgentCtx {
  return { address: "0x0", chain: "eth", spent: 0, receipts: [], findings: {}, ...overrides };
}

function es(flags: Partial<Plan["earlyStop"]> = {}): Plan["earlyStop"] {
  return { onSanctionHit: false, onConfirmedSafeLabel: false, budgetExhausted: false, ...flags };
}

Deno.test("sanctioned=true + flag on -> true", () => {
  const ctx = makeCtx({ findings: { sanctions: { sanctioned: true } } });
  assertEquals(shouldStopEarly(ctx, es({ onSanctionHit: true }), 1), true);
});

Deno.test("sanctioned=true + flag off -> false", () => {
  const ctx = makeCtx({ findings: { sanctions: { sanctioned: true } } });
  assertEquals(shouldStopEarly(ctx, es({ onSanctionHit: false }), 1), false);
});

Deno.test("Binance label (uppercase) + flag on -> true", () => {
  const ctx = makeCtx({ findings: { labels: { labels: ["Binance"] } } });
  assertEquals(shouldStopEarly(ctx, es({ onConfirmedSafeLabel: true }), 1), true);
});

Deno.test("unknown label + flag on -> false", () => {
  const ctx = makeCtx({ findings: { labels: { labels: ["random-label"] } } });
  assertEquals(shouldStopEarly(ctx, es({ onConfirmedSafeLabel: true }), 1), false);
});

Deno.test("budget at 99% + flag on -> true", () => {
  const ctx = makeCtx({ spent: 0.0495 });
  assertEquals(shouldStopEarly(ctx, es({ budgetExhausted: true }), 0.05), true);
});

Deno.test("empty findings + all flags on -> false", () => {
  assertEquals(
    shouldStopEarly(
      makeCtx(),
      es({ onSanctionHit: true, onConfirmedSafeLabel: true, budgetExhausted: true }),
      1,
    ),
    false,
  );
});

Deno.test("sanctions without sanctioned field + flag on -> false", () => {
  const ctx = makeCtx({ findings: { sanctions: {} } });
  assertEquals(shouldStopEarly(ctx, es({ onSanctionHit: true }), 1), false);
});

Deno.test("labels not an array + flag on -> false", () => {
  const ctx = makeCtx({ findings: { labels: { labels: "not-an-array" } } });
  assertEquals(shouldStopEarly(ctx, es({ onConfirmedSafeLabel: true }), 1), false);
});
