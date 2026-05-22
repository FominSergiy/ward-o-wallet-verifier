import { assertEquals, assertRejects } from "@std/assert";
import { custom } from "viem";
import {
  fetchOnchainHistory,
  UnsupportedChainError,
} from "./onchain_viem.ts";

// viem's `custom` transport lets us stub every JSON-RPC method handler the
// PublicClient needs. We map known methods to fixture responses and let any
// unrecognized call throw — that catches accidental fetch attempts in tests.
function stubTransport(responses: {
  txCount?: number;
  balanceWei?: string;
  blockNumber?: number;
}) {
  const txHex = `0x${(responses.txCount ?? 0).toString(16)}`;
  const balanceHex = `0x${BigInt(responses.balanceWei ?? "0").toString(16)}`;
  const blockHex = `0x${(responses.blockNumber ?? 0).toString(16)}`;
  return custom({
    request: ({ method }: { method: string; params?: unknown[] }) => {
      switch (method) {
        case "eth_getTransactionCount":
          return Promise.resolve(txHex);
        case "eth_getBalance":
          return Promise.resolve(balanceHex);
        case "eth_blockNumber":
          return Promise.resolve(blockHex);
        default:
          return Promise.reject(new Error(`unstubbed RPC method: ${method}`));
      }
    },
  });
}

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

Deno.test("fetchOnchainHistory returns tx count, balance, and block from RPC", async () => {
  const r = await fetchOnchainHistory(ADDR, "eth", {
    transport: stubTransport({
      txCount: 42,
      balanceWei: "1500000000000000000", // 1.5 ETH
      blockNumber: 19000000,
    }),
  });
  assertEquals(r.source, "viem");
  assertEquals(r.chain, "eth");
  assertEquals(r.address, ADDR);
  assertEquals(r.txCount, 42);
  assertEquals(r.balanceWei, "1500000000000000000");
  assertEquals(Math.abs(r.balanceEth - 1.5) < 1e-9, true);
  assertEquals(r.currentBlock, 19000000);
});

Deno.test("fetchOnchainHistory works for base chain", async () => {
  const r = await fetchOnchainHistory(ADDR, "base", {
    transport: stubTransport({
      txCount: 0,
      balanceWei: "0",
      blockNumber: 12345,
    }),
  });
  assertEquals(r.chain, "base");
  assertEquals(r.txCount, 0);
  assertEquals(r.balanceEth, 0);
});

// Note: our Chain enum doesn't include unsupported chains directly — they all
// have viem mappings. This is documentation: if a future chain is added to
// the enum without a mapping here, fetchOnchainHistory must throw.
Deno.test("fetchOnchainHistory throws UnsupportedChainError for unknown chain", async () => {
  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => fetchOnchainHistory(ADDR, "made-up-chain" as any),
    UnsupportedChainError,
  );
});
