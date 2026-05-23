import { assertEquals, assertRejects } from "@std/assert";
import {
  CHAINALYSIS_ORACLE_ADDRESS,
  checkSanctionsOracle,
  isOracleSupportedChain,
  OracleUnsupportedChainError,
} from "./sanctions_oracle.ts";
import type { PublicClient } from "viem";

// deno-lint-ignore no-explicit-any
function fakeClient(readResult: any | Error): PublicClient {
  return {
    readContract: (() => {
      if (readResult instanceof Error) return Promise.reject(readResult);
      return Promise.resolve(readResult);
    // deno-lint-ignore no-explicit-any
    }) as any,
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("checkSanctionsOracle: returns isSanctioned=true on sanctioned address", async () => {
  const result = await checkSanctionsOracle(
    "0x098B716B8Aaf21512996dC57EB0615e2383E2f96",
    "eth",
    { client: fakeClient(true) },
  );
  assertEquals(result.isSanctioned, true);
  assertEquals(result.oracleAddress, CHAINALYSIS_ORACLE_ADDRESS);
  assertEquals(result.chain, "eth");
  assertEquals(result.source, "chainalysis_oracle");
});

Deno.test("checkSanctionsOracle: returns isSanctioned=false on clean address", async () => {
  const result = await checkSanctionsOracle(
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "eth",
    { client: fakeClient(false) },
  );
  assertEquals(result.isSanctioned, false);
  assertEquals(result.oracleAddress, CHAINALYSIS_ORACLE_ADDRESS);
});

Deno.test("checkSanctionsOracle: throws on RPC errors instead of silently returning false", async () => {
  await assertRejects(
    () =>
      checkSanctionsOracle(
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "eth",
        { client: fakeClient(new Error("RPC timeout")) },
      ),
    Error,
    "RPC timeout",
  );
});

Deno.test("checkSanctionsOracle: throws OracleUnsupportedChainError on unknown chain", async () => {
  await assertRejects(
    () =>
      checkSanctionsOracle(
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        // deno-lint-ignore no-explicit-any
        "solana" as any,
      ),
    OracleUnsupportedChainError,
  );
});

Deno.test("isOracleSupportedChain: covers the same chains as the onchain_viem fallback", () => {
  assertEquals(isOracleSupportedChain("eth"), true);
  assertEquals(isOracleSupportedChain("base"), true);
  assertEquals(isOracleSupportedChain("polygon"), true);
  assertEquals(isOracleSupportedChain("arbitrum"), true);
  assertEquals(isOracleSupportedChain("optimism"), true);
  assertEquals(isOracleSupportedChain("solana"), false);
  assertEquals(isOracleSupportedChain("base-sepolia"), false);
});

Deno.test("checkSanctionsOracle: result includes checkedAt timestamp and rpcUrl", async () => {
  const before = Date.now();
  const result = await checkSanctionsOracle(
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "base",
    { client: fakeClient(false) },
  );
  const after = Date.now();
  const ts = Date.parse(result.checkedAt);
  assertEquals(ts >= before && ts <= after, true);
  assertEquals(typeof result.rpcUrl, "string");
  assertEquals(result.rpcUrl.length > 0, true);
});
