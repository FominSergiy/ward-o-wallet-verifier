// Post-deploy production E2E. Proves the two telemetry fixes against the LIVE
// deployment after each deploy, so they can't silently regress:
//   A. usage_events is written per request.
//   B. api_key_id / tenant_id attribution lands on the MCP path.
//
// It mints a fresh self-serve key, runs a paid deep check through the hosted
// /mcp (the exact path that was broken), then reads the prod DB to assert both
// rows landed, scoped to its own key/tenant + a recent time window.
//
// MAKES REAL x402 PAID CALLS (~$0.01-$0.05 USDC) and hits live prod + the prod
// DB. Self-gated on RUN_PROD_E2E=1 (distinct from RUN_E2E, the local paid
// pipeline) so the default `deno task test` stays offline + green.
//
//   RUN_PROD_E2E=1 PROD_BASE_URL=https://wallet-verifier.ward-o.deno.net \
//     DATABASE_URL=<prod-readonly> \
//     ~/.deno/bin/deno test --allow-net --allow-env src/routes/prod_e2e_test.ts

import { assert, assertEquals } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { closeDb, dbEnabled, getDb } from "../db/client.ts";
import { WALLET_FIXTURES } from "../fixtures/wallets.ts";

const RUN = Deno.env.get("RUN_PROD_E2E") === "1";
const BASE = Deno.env.get("PROD_BASE_URL") ??
  "https://wallet-verifier.ward-o.deno.net";

const VALID_VERDICTS = new Set([
  "safe_to_transact",
  "do_not_transact",
  "insufficient_data",
]);

// A non-sanctioned fixture, so the deep pipeline actually runs paid x402
// services (→ service_observations rows). A do_not_transact address would
// short-circuit on the free oracle with zero paid calls and zero attributed
// rows, defeating the attribution assertion.
const SAFE_FIXTURE = WALLET_FIXTURES.find((f) =>
  f.expected !== "do_not_transact"
);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll<T>(
  fn: () => Promise<T | null>,
  tries: number,
  delayMs: number,
): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const r = await fn();
    if (r !== null) return r;
    await delay(delayMs);
  }
  return null;
}

Deno.test({
  name:
    "prod E2E: keyed MCP deep check writes attribution + usage rows on live prod",
  ignore: !RUN,
  // The SDK transport / postgres pool can leave async ops mid-teardown; we
  // close them explicitly in the finally, so don't fail on sanitizer races.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    assert(
      dbEnabled(),
      "DATABASE_URL must point at the prod (read-only) branch for the DB asserts",
    );
    assert(SAFE_FIXTURE, "no non-sanctioned fixture available");
    const address = SAFE_FIXTURE.address;

    // 1) Mint a fresh self-serve key.
    const keyRes = await fetch(`${BASE}/request-key`, { method: "POST" });
    assertEquals(keyRes.status, 201, "POST /request-key → 201");
    const { apiKey, prefix } = await keyRes.json();
    assert(
      typeof apiKey === "string" && apiKey.startsWith("wardo_sk_"),
      `unexpected key: ${apiKey}`,
    );

    // 2) Resolve the minted key's id + tenant from the DB.
    const db = getDb();
    const keyRows = (await db`
      SELECT id, tenant_id FROM api_keys WHERE key_prefix = ${prefix} LIMIT 1
    `) as { id: string; tenant_id: string }[];
    const keyRow = keyRows[0];
    assert(keyRow, `minted key ${prefix} not found in api_keys`);

    try {
      await t.step(
        "mints a key and a keyed deep check returns a valid verdict from prod",
        async () => {
          const client = new Client({ name: "prod-e2e", version: "0" });
          const transport = new StreamableHTTPClientTransport(
            new URL(`${BASE}/mcp`),
            { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } },
          );
          try {
            await client.connect(transport);
            const res = await client.callTool({
              name: "get_deep_verdict",
              arguments: { deepCheckToken: address },
            });
            const sc = res.structuredContent as
              | Record<string, unknown>
              | undefined;
            assert(sc, "get_deep_verdict returned no structuredContent");
            assert(
              typeof sc.verdict === "string" && VALID_VERDICTS.has(sc.verdict),
              `unexpected verdict: ${JSON.stringify(sc.verdict)}`,
            );
          } finally {
            await client.close().catch(() => {});
          }
        },
      );

      await t.step(
        "the deep check writes service_observations attributed to the minted key",
        async () => {
          const found = await poll(
            async () => {
              const rows = (await db`
              SELECT count(*)::int AS n
              FROM service_observations
              WHERE api_key_id = ${keyRow.id}
                AND created_at > now() - interval '3 minutes'
            `) as { n: number }[];
              return (rows[0]?.n ?? 0) >= 1 ? rows[0].n : null;
            },
            8,
            1500,
          );
          assert(
            found !== null,
            `no service_observations attributed to api_key_id=${keyRow.id}`,
          );
        },
      );

      await t.step(
        "the deep check writes a usage_events row for the minted key's tenant",
        async () => {
          const found = await poll(
            async () => {
              const rows = (await db`
              SELECT count(*)::int AS n
              FROM usage_events
              WHERE tenant_id = ${keyRow.tenant_id}
                AND verdict IS NOT NULL
                AND created_at > now() - interval '3 minutes'
            `) as { n: number }[];
              return (rows[0]?.n ?? 0) >= 1 ? rows[0].n : null;
            },
            8,
            1500,
          );
          assert(
            found !== null,
            `no usage_events row for tenant_id=${keyRow.tenant_id}`,
          );
        },
      );
    } finally {
      await closeDb();
    }
  },
});
