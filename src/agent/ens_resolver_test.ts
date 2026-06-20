import { assertEquals, assertRejects } from "@std/assert";
import { ensSupportedFor, resolveEns } from "./ens_resolver.ts";
import type { PublicClient } from "viem";
import { type KvStore, newMemoryKv } from "../cache/kv.ts";

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
    { client: fakeClient("vitalik.eth"), cache: newMemoryKv() },
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
    { client: fakeClient(null), cache: newMemoryKv() },
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
        {
          client: fakeClient(new Error("RPC unavailable")),
          cache: newMemoryKv(),
        },
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

Deno.test("resolveEns: second call for same address hits cache, no extra network call", async () => {
  let ensNameCalls = 0;
  const cache: KvStore = (() => {
    const store = new Map<string, unknown>();
    return {
      get: async <T>(key: string) => (store.get(key) as T) ?? null,
      set: async <T>(key: string, value: T) => {
        store.set(key, value);
      },
    };
  })();

  // Single client shared across both calls — getEnsName is the network boundary.
  const client: PublicClient = {
    getEnsName: () => {
      ensNameCalls++;
      return Promise.resolve("vitalik.eth");
    },
    // deno-lint-ignore no-explicit-any
  } as any;

  const addr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const r1 = await resolveEns(addr, "eth", { client, cache });
  const r2 = await resolveEns(addr, "eth", { client, cache });

  assertEquals(r1.ensName, "vitalik.eth");
  assertEquals(r2.ensName, "vitalik.eth");
  // Second call should return the cached result — getEnsName fires only once.
  assertEquals(ensNameCalls, 1);
});

Deno.test("resolveEns: result includes checkedAt timestamp", async () => {
  const before = Date.now();
  const r = await resolveEns(
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "eth",
    { client: fakeClient("vitalik.eth"), cache: newMemoryKv() },
  );
  const after = Date.now();
  const ts = Date.parse(r.checkedAt);
  assertEquals(ts >= before && ts <= after, true);
});
