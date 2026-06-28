import { assertEquals } from "@std/assert";
import { budgetThreshold } from "./budget.ts";

const KEY = "AGNIC_BUDGET_MIN_USD";

function withEnv(value: string | undefined, fn: () => void) {
  const prev = Deno.env.get(KEY);
  if (value === undefined) Deno.env.delete(KEY);
  else Deno.env.set(KEY, value);
  try {
    fn();
  } finally {
    if (prev === undefined) Deno.env.delete(KEY);
    else Deno.env.set(KEY, prev);
  }
}

Deno.test("budgetThreshold: defaults to 0.10 when unset", () => {
  withEnv(undefined, () => assertEquals(budgetThreshold(), 0.10));
});

Deno.test("budgetThreshold: parses a valid override", () => {
  withEnv("0.50", () => assertEquals(budgetThreshold(), 0.50));
});

Deno.test("budgetThreshold: falls back to default on garbage", () => {
  withEnv("not-a-number", () => assertEquals(budgetThreshold(), 0.10));
});

Deno.test("budgetThreshold: falls back to default on negative", () => {
  withEnv("-1", () => assertEquals(budgetThreshold(), 0.10));
});
