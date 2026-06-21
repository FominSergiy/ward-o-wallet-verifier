import { assertEquals, assertExists } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer, formatResult } from "./server.ts";
import { memoryDenylist } from "../agent/sanctioned_denylist.ts";
import type { VerifyAgentResult } from "../agent/verify.ts";
import type { WalletVerdict } from "../agent/verdict.ts";

const ADDR = "0xD90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b";

function verdict(v: WalletVerdict["verdict"]): WalletVerdict {
  return {
    address: ADDR,
    chain: "eth",
    safe: v === "safe_to_transact",
    verdict: v,
    confidence: "low",
    headline: "h",
    reasoning: "r",
    findings: [],
    coverage: { requested: [], resolved: [], unresolved: [] },
    totalSpentUsdc: 0,
    generatedAt: new Date().toISOString(),
  };
}

// --- formatResult unit tests ---

Deno.test("formatResult: needs_deep_check attaches a deepCheckToken", () => {
  const result: VerifyAgentResult = {
    verdict: verdict("insufficient_data"),
    // deno-lint-ignore no-explicit-any
    plan: {} as any,
    outcomes: [],
    walletNetwork: "base",
    totalSpentUsdc: 0,
    totalLlmCostUsd: 0,
    tier: "fast",
    fastSignal: "needs_deep_check",
  };
  const out = formatResult(result);
  assertEquals(out.structuredContent.fastSignal, "needs_deep_check");
  const deepCheck = out.structuredContent.deepCheck as Record<string, unknown>;
  assertExists(deepCheck);
  assertEquals(deepCheck.deepCheckToken, ADDR);
});

Deno.test("formatResult: block result has no deepCheck", () => {
  const result: VerifyAgentResult = {
    verdict: verdict("do_not_transact"),
    // deno-lint-ignore no-explicit-any
    plan: {} as any,
    outcomes: [],
    walletNetwork: "base",
    totalSpentUsdc: 0,
    totalLlmCostUsd: 0,
    tier: "fast",
    fastSignal: "block",
  };
  const out = formatResult(result);
  assertEquals(out.structuredContent.deepCheck, undefined);
  assertEquals(out.structuredContent.fastSignal, "block");
});

// --- MCP round-trip (offline via denylist hit) ---

async function connectedClient(denylist = memoryDenylist()) {
  const server = buildMcpServer(undefined, denylist);
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, denylist };
}

Deno.test("MCP: both verify_wallet and get_deep_verdict are registered", async () => {
  const { client } = await connectedClient();
  const { tools } = await client.listTools();
  const names = tools.map((t: { name: string }) => t.name).sort();
  assertEquals(names, ["get_deep_verdict", "verify_wallet"]);
  await client.close();
});

Deno.test("MCP: verify_wallet on a denylisted address returns block, $0 (offline)", async () => {
  const denylist = memoryDenylist();
  await denylist.set("eth", ADDR, {
    reason: "OFAC SDN",
    source: "ofac:0xB10C",
    warmedAt: new Date().toISOString(),
  });
  const { client } = await connectedClient(denylist);

  const res = await client.callTool({
    name: "verify_wallet",
    arguments: { address: ADDR }, // depth defaults to fast
  });

  const structured = res.structuredContent as Record<string, unknown>;
  assertEquals(structured.verdict, "do_not_transact");
  assertEquals(structured.fastSignal, "block");
  assertEquals(structured.totalSpentUsdc, 0);
  await client.close();
});
