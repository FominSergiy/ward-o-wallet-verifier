import type { Context } from "hono";
import { lookupApiKey, type ResolvedKey } from "../auth/api_keys.ts";

// Best-effort key attribution for the open (keyless) HTTP routes. The web UI
// sends its embedded `web-ui` key as a Bearer purely so its paid runs get
// tagged in service_observations; a missing/invalid/unknown key just runs
// anonymously (null). NEVER rejects — these routes stay open to everyone.
//
// Callers wrap the verify pipeline call in runWithApiKey(resolvedId, …) so the
// ambient id reaches the fire-and-forget observation writer. We resolve the id
// up front (one indexed DB lookup) rather than via Hono middleware, because the
// SSE route runs the pipeline inside a stream callback that can outlive the
// middleware's next() — wrapping the actual call is what guarantees scope.

export async function resolveApiKeyId(
  c: Context,
  lookup: (token: string) => Promise<ResolvedKey | null> = lookupApiKey,
): Promise<string | null> {
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : "";
  if (!bearer) return null;
  try {
    const resolved = await lookup(bearer);
    return resolved?.id ?? null;
  } catch {
    return null;
  }
}
