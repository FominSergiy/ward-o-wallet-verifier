import { Hono } from "hono";
import { issueApiKey, type IssuedKey } from "../auth/api_keys.ts";
import { jsonErrorBody, mapRouteError } from "./errors.ts";

// POST /request-key — self-serve key issuance. Intentionally unauthenticated and
// body-optional so the documented `curl -X POST .../request-key` just works. An
// optional `{ "label": "my-agent" }` names the tenant for your own bookkeeping.
//
// The plaintext key is returned ONCE in the response; only its hash is stored.

export interface RequestKeyDeps {
  // Injection seam for offline tests; real callers leave it undefined.
  issueKey?: (label?: string) => Promise<IssuedKey>;
}

export function createRequestKeyRouter(deps: RequestKeyDeps = {}): Hono {
  const issue = deps.issueKey ?? issueApiKey;
  const router = new Hono();

  router.post("/", async (c) => {
    // Tolerate a missing or non-JSON body — no body is the common curl case.
    let label: string | undefined;
    try {
      const raw = await c.req.json();
      if (raw && typeof raw.label === "string" && raw.label.trim()) {
        label = raw.label.trim().slice(0, 200);
      }
    } catch {
      // empty / invalid body → anonymous key
    }

    try {
      const key = await issue(label);
      return c.json({
        apiKey: key.token,
        prefix: key.prefix,
        note:
          "Store this key now — it is shown once and cannot be recovered. " +
          "Pass it as the Bearer token to the Ward-o MCP server.",
      }, 201);
    } catch (e) {
      const mapped = mapRouteError(e);
      if (mapped) return c.json(jsonErrorBody(mapped), mapped.status);
      if (e instanceof Error && e.message.startsWith("api_keys_db_required")) {
        return c.json({
          error: "db_required",
          message: "Key issuance requires a configured database.",
        }, 503);
      }
      throw e;
    }
  });

  return router;
}

/** Default instance for main.ts. */
export const requestKeyRouter = createRequestKeyRouter();
