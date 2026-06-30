// Per-request ambient context, carried via AsyncLocalStorage so the deep,
// fire-and-forget metrics writers (observations.ts, usage.ts) can attribute a
// run to the issued API key (and its tenant) that triggered it WITHOUT
// threading those ids through the whole verify pipeline (verify.ts →
// invoke_all.ts → events).
//
// Authenticated callers (the MCP tool handlers, the keyed HTTP routes) wrap the
// actual verify pipeline call in runWithRequestContext(); anything awaited
// inside that scope — including the verify pipeline and its observation /
// usage INSERTs — reads currentApiKeyId() / currentTenantId().

import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  apiKeyId?: string;
  tenantId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with `apiKeyId` + `tenantId` (each null for anonymous) as the
 * ambient request context. The pipeline call must be wrapped directly — see the
 * note in routes/key_attribution.ts about the SSE/streaming boundary.
 */
export function runWithRequestContext<T>(
  apiKeyId: string | null,
  tenantId: string | null,
  fn: () => T,
): T {
  return storage.run(
    { apiKeyId: apiKeyId ?? undefined, tenantId: tenantId ?? undefined },
    fn,
  );
}

/** The ambient API key id for the current async context, or null if none. */
export function currentApiKeyId(): string | null {
  return storage.getStore()?.apiKeyId ?? null;
}

/** The ambient tenant id for the current async context, or null if none. */
export function currentTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}
