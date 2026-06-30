// Self-serve API keys — activates the dormant 0001 `tenants` + `api_keys`
// tables. A key unlocks the MCP server: the caller passes it as the Bearer
// token, and src/mcp/http.ts hashes + looks it up here. Only the SHA-256 hash
// is ever persisted; the plaintext `wardo_sk_…` token is shown to the caller
// exactly once at issuance.
//
// No spend cap is enforced yet (product is free) — we only attribute per-key
// usage in service_observations. A later migration can add api_keys.spend_cap.

import { dbEnabled, getDb } from "../db/client.ts";

const TOKEN_PREFIX = "wardo_sk_";
// Stored display fragment: prefix + first 8 hex chars of the random body. Not a
// secret — just enough to recognize a key in logs/admin without revealing it.
const DISPLAY_PREFIX_LEN = TOKEN_PREFIX.length + 8;

/** A freshly issued key: the one-time plaintext token plus its DB attributes. */
export interface IssuedKey {
  token: string;
  prefix: string;
  tenantId: string;
  apiKeyId: string;
}

/** A resolved (valid, non-revoked) key — what lookupApiKey returns on a hit. */
export interface ResolvedKey {
  id: string;
  tenantId: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new opaque token: `wardo_sk_` + 32 random bytes as hex. */
export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX + toHex(bytes);
}

/** SHA-256 hex of the input — the value stored in api_keys.key_hash. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}

/** The non-secret display fragment stored in api_keys.key_prefix. */
export function keyPrefixOf(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_LEN);
}

/** True for strings shaped like one of our tokens (cheap pre-filter). */
export function looksLikeToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

/**
 * Mint a key: create a tenant (named by the optional label) and an api_keys row
 * holding only the hash. Returns the one-time plaintext token. Requires a
 * configured database — throws `api_keys_db_required` otherwise.
 */
export async function issueApiKey(label?: string): Promise<IssuedKey> {
  if (!dbEnabled()) {
    throw new Error(
      "api_keys_db_required: DATABASE_URL is not set; cannot issue API keys",
    );
  }
  const db = getDb();
  const token = newToken();
  const keyHash = await sha256Hex(token);
  const prefix = keyPrefixOf(token);
  const name = label && label.trim() ? label.trim().slice(0, 200) : "anonymous";

  const tenantRows = (await db`
    INSERT INTO tenants (name) VALUES (${name}) RETURNING id
  `) as { id: string }[];
  const tenantId = tenantRows[0]?.id;
  if (!tenantId) {
    throw new Error("api_keys_insert_failed: tenant insert returned no row");
  }

  // scopes defaults to '{}' in the schema; we don't enforce scopes yet.
  const keyRows = (await db`
    INSERT INTO api_keys (tenant_id, key_hash, key_prefix)
    VALUES (${tenantId}, ${keyHash}, ${prefix})
    RETURNING id
  `) as { id: string }[];
  const apiKeyId = keyRows[0]?.id;
  if (!apiKeyId) {
    throw new Error("api_keys_insert_failed: api_keys insert returned no row");
  }

  return { token, prefix, tenantId, apiKeyId };
}

/**
 * Resolve a Bearer token to its key id (and tenant). Returns null for anything
 * not shaped like a token, when no DB is configured, or on no match. Bumps
 * last_used_at fire-and-forget on a hit.
 */
export async function lookupApiKey(token: string): Promise<ResolvedKey | null> {
  if (!token || !looksLikeToken(token)) return null;
  if (!dbEnabled()) return null;

  const db = getDb();
  const keyHash = await sha256Hex(token);
  const rows = (await db`
    SELECT id, tenant_id
    FROM api_keys
    WHERE key_hash = ${keyHash} AND revoked_at IS NULL
    LIMIT 1
  `) as { id: string; tenant_id: string }[];

  const row = rows[0];
  if (!row) return null;

  // Best-effort recency stamp; never block or fail the auth path on it.
  Promise.resolve(
    db`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id}`,
  ).catch(() => {});

  return { id: row.id, tenantId: row.tenant_id };
}
