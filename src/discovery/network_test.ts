import { assertEquals, assertRejects } from "@std/assert";
import { _resetNetworkCacheForTests, detectWalletNetwork, toCaip2 } from "./network.ts";
import { WalletUnfundedError } from "./types.ts";

// Tests assume a fresh cache state for each case.
function resetCache() {
  _resetNetworkCacheForTests();
}

function mockBalance(args: {
  mainnetUsdc: string;
  sepoliaUsdc: string;
  mainnetAddress?: string;
  sepoliaAddress?: string;
}): typeof globalThis.fetch {
  return (url, _init) => {
    const u = url.toString();
    const isMainnet = u.includes("network=base");
    const body = isMainnet
      ? {
        usdcBalance: args.mainnetUsdc,
        address: args.mainnetAddress ?? "0xMAIN",
        hasWallet: true,
        network: "base",
        chainType: "ethereum",
        creditBalance: "50",
        totalBalance: "50",
      }
      : {
        usdcBalance: args.sepoliaUsdc,
        address: args.sepoliaAddress ?? "0xSEP",
        hasWallet: true,
        network: "base-sepolia",
        chainType: "ethereum",
        creditBalance: "50",
        totalBalance: "50",
      };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

Deno.test("detectWalletNetwork prefers mainnet when both wallets funded", async () => {
  resetCache();
  Deno.env.set("AGNIC_API_KEY", "k");
  try {
    const result = await detectWalletNetwork(
      mockBalance({ mainnetUsdc: "0.5", sepoliaUsdc: "0.5" }),
    );
    assertEquals(result, "base");
  } finally {
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("detectWalletNetwork returns sepolia when only sepolia funded", async () => {
  resetCache();
  Deno.env.set("AGNIC_API_KEY", "k");
  try {
    const result = await detectWalletNetwork(
      mockBalance({ mainnetUsdc: "0", sepoliaUsdc: "1.0" }),
    );
    assertEquals(result, "base-sepolia");
  } finally {
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("detectWalletNetwork returns base when only mainnet funded", async () => {
  resetCache();
  Deno.env.set("AGNIC_API_KEY", "k");
  try {
    const result = await detectWalletNetwork(
      mockBalance({ mainnetUsdc: "2.0", sepoliaUsdc: "0" }),
    );
    assertEquals(result, "base");
  } finally {
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("detectWalletNetwork throws WalletUnfundedError when neither funded", async () => {
  resetCache();
  Deno.env.set("AGNIC_API_KEY", "k");
  try {
    await assertRejects(
      () =>
        detectWalletNetwork(
          mockBalance({
            mainnetUsdc: "0",
            sepoliaUsdc: "0",
            mainnetAddress: "0xAAA",
            sepoliaAddress: "0xBBB",
          }),
        ),
      WalletUnfundedError,
      "0xAAA",
    );
    // also assert sepolia address in the message
    try {
      await detectWalletNetwork(
        mockBalance({
          mainnetUsdc: "0",
          sepoliaUsdc: "0",
          mainnetAddress: "0xAAA",
          sepoliaAddress: "0xBBB",
        }),
      );
    } catch (e) {
      assertEquals((e as Error).message.includes("0xBBB"), true);
    }
  } finally {
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("detectWalletNetwork throws when AGNIC_API_KEY missing", async () => {
  resetCache();
  Deno.env.delete("AGNIC_API_KEY");
  await assertRejects(
    () => detectWalletNetwork(),
    Error,
    "AGNIC_API_KEY not set",
  );
});

Deno.test("toCaip2 maps both network values", () => {
  assertEquals(toCaip2("base"), "eip155:8453");
  assertEquals(toCaip2("base-sepolia"), "eip155:84532");
});
