import { assertEquals } from "@std/assert";
import { resolveBazaarEndpoints } from "./resolve.ts";

Deno.test("resolveBazaarEndpoints returns correct providers", () => {
  const calls = resolveBazaarEndpoints(["sanctions", "ens"], "eth");
  assertEquals(calls.length, 2);
  assertEquals(calls[0].provider, "bazaar/ofac");
  assertEquals(calls[0].estimatedCostUsdc, 0.001);
  assertEquals(calls[1].estimatedCostUsdc, 0);
});

Deno.test("resolveBazaarEndpoints is deterministic", () => {
  const a = resolveBazaarEndpoints(["labels", "onchain_history"], "eth");
  const b = resolveBazaarEndpoints(["labels", "onchain_history"], "eth");
  assertEquals(JSON.stringify(a), JSON.stringify(b));
});

Deno.test("resolveBazaarEndpoints returns empty for empty input", () => {
  assertEquals(resolveBazaarEndpoints([], "eth"), []);
});

Deno.test("resolveBazaarEndpoints preserves input order", () => {
  const calls = resolveBazaarEndpoints(["ens", "sanctions"], "eth");
  assertEquals(calls[0].provider, "viem/public-rpc");
  assertEquals(calls[1].provider, "bazaar/ofac");
});
