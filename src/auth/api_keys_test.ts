import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  issueApiKey,
  keyPrefixOf,
  looksLikeToken,
  lookupApiKey,
  newToken,
  sha256Hex,
} from "./api_keys.ts";
import { closeDb, getDb } from "../db/client.ts";

Deno.test("newToken: distinct tokens with the wardo_sk_ prefix", () => {
  const a = newToken();
  const b = newToken();
  assertNotEquals(a, b);
  assertEquals(a.startsWith("wardo_sk_"), true);
  assertEquals(looksLikeToken(a), true);
  assertEquals(looksLikeToken("nope"), false);
});

Deno.test("sha256Hex: deterministic, matches the known SHA-256('abc') vector", async () => {
  const h1 = await sha256Hex("abc");
  const h2 = await sha256Hex("abc");
  assertEquals(h1, h2);
  assertEquals(
    h1,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("keyPrefixOf: stable 17-char display fragment", () => {
  assertEquals(keyPrefixOf("wardo_sk_0123456789abcdef"), "wardo_sk_01234567");
});

Deno.test("lookupApiKey: null for non-token-shaped input (any mode)", async () => {
  assertEquals(await lookupApiKey("garbage"), null);
  assertEquals(await lookupApiKey(""), null);
});

Deno.test({
  name: "lookupApiKey: null on no-op DB for a token-shaped miss",
  ignore: !!Deno.env.get("DATABASE_URL"),
  fn: async () => {
    assertEquals(await lookupApiKey("wardo_sk_" + "0".repeat(64)), null);
  },
});

Deno.test({
  name: "issueApiKey: rejects without a database",
  ignore: !!Deno.env.get("DATABASE_URL"),
  fn: async () => {
    await assertRejects(
      () => issueApiKey("offline"),
      Error,
      "api_keys_db_required",
    );
  },
});

// Real round-trip — only when a DATABASE_URL (Neon dev branch) is configured.
// Mints a key, resolves it back, then cleans up both rows.
Deno.test({
  name: "E2E: issue → lookup round-trips through the real DB",
  ignore: !Deno.env.get("DATABASE_URL"),
  fn: async () => {
    const issued = await issueApiKey("e2e-smoke");
    try {
      const resolved = await lookupApiKey(issued.token);
      assertEquals(resolved?.id, issued.apiKeyId);
      assertEquals(resolved?.tenantId, issued.tenantId);
      assertEquals(await lookupApiKey("wardo_sk_" + "0".repeat(64)), null);
    } finally {
      const db = getDb();
      await db`DELETE FROM api_keys WHERE id = ${issued.apiKeyId}`;
      await db`DELETE FROM tenants WHERE id = ${issued.tenantId}`;
      await closeDb();
    }
  },
});
