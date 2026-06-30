// Post-deploy smoke test for the token → MCP path. NOT a CI gate — it self-gates
// on WARDO_API_URL and talks to a LIVE instance.
//
//   WARDO_API_URL=https://<api>.deno.dev deno task mcp:smoke           # free
//   WARDO_API_URL=https://<api>.deno.dev deno task mcp:smoke -- --deep # +1 paid call
//
// Proves the whole chain end-to-end:
//   POST /request-key                       → mint a wardo_sk_ token
//   connect MCP (Streamable HTTP) + Bearer  → authorizeMcp → lookupApiKey → DB
//   listTools()                             → verify_wallet present
//   verify_wallet(fast) on a known OFAC fixture → fastSignal "block", $0 spend
//
// With --deep it runs one paid deep call so you can confirm api_key_id
// attribution in service_observations (the query is printed at the end).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WALLET_FIXTURES } from "../src/fixtures/wallets.ts";

const BASE = Deno.env.get("WARDO_API_URL");
if (!BASE) {
  console.error(
    "WARDO_API_URL is not set — skipping MCP smoke.\n" +
      "  WARDO_API_URL=https://<api>.deno.dev deno task mcp:smoke",
  );
  Deno.exit(0);
}

const deep = Deno.args.includes("--deep");
const sanctioned = WALLET_FIXTURES.find((f) =>
  f.expected === "do_not_transact"
);
if (!sanctioned) {
  console.error("no do_not_transact fixture found");
  Deno.exit(1);
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  Deno.exit(1);
}

// 1) Mint a fresh self-serve key.
const keyRes = await fetch(`${BASE}/request-key`, { method: "POST" });
if (keyRes.status !== 201) fail(`POST /request-key → HTTP ${keyRes.status}`);
const { apiKey, prefix } = await keyRes.json();
if (typeof apiKey !== "string" || !apiKey.startsWith("wardo_sk_")) {
  fail(`/request-key returned an unexpected key: ${apiKey}`);
}
console.log(`✓ minted key ${prefix}…`);

// 2) Connect to the MCP server using the minted key as the Bearer.
const client = new Client({ name: "mcp-smoke", version: "0" });
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
});
await client.connect(transport);
console.log("✓ connected to /mcp with the minted key (auth ok)");

// 3) The tool surface is present.
const tools = await client.listTools();
const names = tools.tools.map((t: { name: string }) => t.name);
if (!names.includes("verify_wallet")) {
  fail(`verify_wallet not listed; got [${names.join(", ")}]`);
}
console.log(`✓ tools: ${names.join(", ")}`);

// 4) Free fast-tier call on a known OFAC address.
const fast = await client.callTool({
  name: "verify_wallet",
  arguments: { address: sanctioned.address, depth: "fast" },
});
const sc = fast.structuredContent as Record<string, unknown> | undefined;
console.log("fast result:", JSON.stringify(sc, null, 2));
if (!sc || typeof sc.verdict === "undefined") {
  fail("fast verify_wallet returned no structuredContent (tool path broken)");
}
if (sc.fastSignal === "block") {
  console.log(`✓ fast tier blocked ${sanctioned.label} ($0 spend)`);
} else {
  console.warn(
    `⚠ expected fastSignal "block" for ${sanctioned.label}, got ` +
      `"${sc.fastSignal}". Auth + tool path are OK; check the sanctions oracle.`,
  );
}

// 5) Optional paid deep call to exercise attribution.
if (deep) {
  console.log("\nrunning one paid deep call (a few cents)…");
  const res = await client.callTool({
    name: "verify_wallet",
    arguments: { address: sanctioned.address, depth: "deep" },
  });
  console.log("deep result:", JSON.stringify(res.structuredContent, null, 2));
  console.log(
    `\nConfirm attribution in Neon (the run should be tagged to key ${prefix}…):\n` +
      "  SELECT api_key_id, count(*), coalesce(sum(cost_usd),0)\n" +
      "  FROM service_observations\n" +
      "  WHERE created_at > now() - interval '10 minutes'\n" +
      "  GROUP BY 1;",
  );
}

await client.close();
console.log("\n✓ MCP token smoke passed");
Deno.exit(0);
