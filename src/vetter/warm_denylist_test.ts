import { assertEquals } from "@std/assert";
import { warmSanctionedDenylist } from "./run.ts";
import { memoryDenylist } from "../agent/sanctioned_denylist.ts";
import type { Chain } from "../agent/types.ts";
import type { OracleResult } from "../agent/sanctions_oracle.ts";

const A1 = "0x098b716b8aaf21512996dc57eb0615e2383e2f96";
const A2 = "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b";

Deno.test("warmSanctionedDenylist: writes all fetched addresses ($0, no cross-check)", async () => {
  const denylist = memoryDenylist();
  const result = await warmSanctionedDenylist({
    denylist,
    fetchAddresses: () =>
      Promise.resolve({ addresses: [A1, A2], source: "ofac:0xB10C" }),
  });

  assertEquals(result.fetched, 2);
  assertEquals(result.written, 2);
  assertEquals(result.skipped, 0);
  assertEquals(result.source, "ofac:0xB10C");

  const hit = await denylist.has("eth", A1);
  assertEquals(hit?.reason, "OFAC SDN");
  assertEquals(hit?.source, "ofac:0xB10C");
});

Deno.test("warmSanctionedDenylist: cross-check skips not-sanctioned addresses", async () => {
  const denylist = memoryDenylist();
  const oracleCheckFn = (
    address: string,
    chain: Chain,
  ): Promise<OracleResult> =>
    Promise.resolve({
      source: "chainalysis_oracle",
      oracleAddress: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
      chain,
      // A1 confirmed sanctioned, A2 not.
      isSanctioned: address.toLowerCase() === A1,
      checkedAt: new Date().toISOString(),
      rpcUrl: "https://test.rpc",
    });

  const result = await warmSanctionedDenylist({
    denylist,
    fetchAddresses: () =>
      Promise.resolve({ addresses: [A1, A2], source: "ofac:0xB10C" }),
    crossCheck: true,
    oracleCheckFn,
  });

  assertEquals(result.written, 1);
  assertEquals(result.skipped, 1);
  assertEquals((await denylist.has("eth", A1))?.reason, "OFAC SDN");
  assertEquals(await denylist.has("eth", A2), null);
});

Deno.test("warmSanctionedDenylist: cross-check RPC failure writes anyway (trusts OFAC)", async () => {
  const denylist = memoryDenylist();
  const result = await warmSanctionedDenylist({
    denylist,
    fetchAddresses: () =>
      Promise.resolve({ addresses: [A1], source: "ofac:0xB10C" }),
    crossCheck: true,
    oracleCheckFn: () => Promise.reject(new Error("rpc down")),
  });

  assertEquals(result.written, 1);
  assertEquals(result.skipped, 0);
});
