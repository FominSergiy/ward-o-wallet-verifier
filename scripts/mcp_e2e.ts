// End-to-end test: spawn the stdio MCP server, list tools, then invoke
// `verify_wallet` against a known-clean wallet (vitalik.eth on eth) with a
// $0.05 budget cap. Prints the verdict JSON and exits.
//
// Run: deno run -A --env-file=.env scripts/mcp_e2e.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const denoBin = `${Deno.env.get("HOME")}/.deno/bin/deno`;

const transport = new StdioClientTransport({
  command: denoBin,
  args: [
    "run",
    "--allow-net",
    "--allow-env",
    "--allow-read",
    "--allow-write",
    "--env-file=.env",
    "src/mcp/stdio.ts",
  ],
});

const client = new Client({ name: "e2e-test", version: "0.0.1" });
await client.connect(transport);

console.log("=== tools/list ===");
const tools = await client.listTools();
console.log(JSON.stringify(tools, null, 2));

console.log("\n=== calling verify_wallet (vitalik.eth on eth, budget $0.05) ===");
const started = Date.now();
// verifyAgent makes 5+ paid x402 calls plus an Opus synthesis — comfortably
// over the SDK's 60s default. Give it 5 minutes.
const result = await client.callTool(
  {
    name: "verify_wallet",
    arguments: {
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      chain: "eth",
      budgetCeiling: 0.05,
    },
  },
  undefined,
  { timeout: 300_000 },
);
const elapsedMs = Date.now() - started;

console.log(`\n=== result (took ${elapsedMs}ms) ===`);
console.log(JSON.stringify(result, null, 2));

await client.close();
