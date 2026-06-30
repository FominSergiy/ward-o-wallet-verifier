// Per-request ambient context, carried via AsyncLocalStorage so the deep,
// fire-and-forget metrics writer (observations.ts) can attribute a service call
// to the issued API key that triggered the run WITHOUT threading the key id
// through the whole verify pipeline (verify.ts → invoke_all.ts → events).
//
// The MCP HTTP transport (and any future authenticated route) wraps request
// handling in runWithApiKey(); anything awaited inside that scope — including
// the verify pipeline and its observation INSERTs — reads currentApiKeyId().

import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  apiKeyId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `apiKeyId` (or null for anonymous) as the ambient key id. */
export function runWithApiKey<T>(apiKeyId: string | null, fn: () => T): T {
  return storage.run({ apiKeyId: apiKeyId ?? undefined }, fn);
}

/** The ambient API key id for the current async context, or null if none. */
export function currentApiKeyId(): string | null {
  return storage.getStore()?.apiKeyId ?? null;
}
