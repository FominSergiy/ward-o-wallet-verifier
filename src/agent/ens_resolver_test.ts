import { assertEquals, assertRejects } from "@std/assert";
import { ensSupportedFor, resolveEns } from "./ens_resolver.ts";
import type { PublicClient } from "viem";

// deno-lint-ignore no-explicit-any
function fakeClient(ensResult: any | Error): PublicClient {
  return {
    getEnsName: (() => {
      if (ensResult instanceof Error) return Promise.reject(ensResult);
      return Promise.resolve(ensResult);
    // deno-lint-ignore no-explicit-any
    }) as any,
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("resolveEns: returns ENS name for a doxxed wallet on eth", async () => {
  const r = await resolveEns(
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "eth",
    { client: fakeClient("vitalik.eth") },
  );
  assertEquals(r.ensName, "vitalik.eth");
  assertEquals(r.source, "viem_ens");
  assertEquals(r.chain, "eth");
  assertEquals(r.address, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
});

Deno.test("resolveEns: returns null for a wallet with no ENS name", async () => {
  const r = await resolveEns(
    "0xABC0000000000000000000000000000000000123",
    "eth",
    { client: fakeClient(null) },
  );
  assertEquals(r.ensName, null);
  assertEquals(r.source, "viem_ens");
});

Deno.test("resolveEns: returns null without RPC call when chain is not eth", async () => {
  // No client provided — would throw if we tried to actually open one.
  const r = await resolveEns(
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "base",
  );
  assertEquals(r.ensName, null);
  assertEquals(r.chain, "base");
});

Deno.test("resolveEns: throws on RPC errors (no silent fallback to null)", async () => {
  await assertRejects(
    () =>
      resolveEns(
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "eth",
        { client: fakeClient(new Error("RPC unavailable")) },
      ),
    Error,
    "RPC unavailable",
  );
});

Deno.test("ensSupportedFor: only eth is supported for native reverse resolution", () => {
  assertEquals(ensSupportedFor("eth"), true);
  assertEquals(ensSupportedFor("base"), false);
  assertEquals(ensSupportedFor("polygon"), false);
  assertEquals(ensSupportedFor("arbitrum"), false);
  assertEquals(ensSupportedFor("optimism"), false);
});

Deno.test("resolveEns: result includes checkedAt timestamp", async () => {
  const before = Date.now();
  const r = await resolveEns(
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "eth",
    { client: fakeClient("vitalik.eth") },
  );
  const after = Date.now();
  const ts = Date.parse(r.checkedAt);
  assertEquals(ts >= before && ts <= after, true);
});
