import { assert, assertEquals } from "@std/assert";
import { VerdictEnum } from "../agent/verdict.ts";
import { WALLET_FIXTURES } from "./wallets.ts";

Deno.test("wallet fixtures: addresses are valid 0x-40-hex", () => {
  for (const f of WALLET_FIXTURES) {
    assert(
      /^0x[0-9a-fA-F]{40}$/.test(f.address),
      `invalid address for ${f.label}: ${f.address}`,
    );
  }
});

Deno.test("wallet fixtures: expected verdict is a known Verdict", () => {
  const valid = new Set(VerdictEnum.options);
  for (const f of WALLET_FIXTURES) {
    assert(
      valid.has(f.expected),
      `unknown verdict for ${f.label}: ${f.expected}`,
    );
  }
});

Deno.test("wallet fixtures: addresses are unique", () => {
  const lower = WALLET_FIXTURES.map((f) => f.address.toLowerCase());
  assertEquals(new Set(lower).size, lower.length);
});
