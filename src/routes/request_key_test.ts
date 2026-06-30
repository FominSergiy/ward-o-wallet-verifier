import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { createRequestKeyRouter } from "./request_key.ts";
import type { IssuedKey } from "../auth/api_keys.ts";

function appWith(issueKey: (label?: string) => Promise<IssuedKey>): Hono {
  const app = new Hono();
  app.route("/request-key", createRequestKeyRouter({ issueKey }));
  return app;
}

Deno.test("POST /request-key returns the minted key (201) and passes the label", async () => {
  let seenLabel: string | undefined = "UNSET";
  const app = appWith((label) => {
    seenLabel = label;
    return Promise.resolve({
      token: "wardo_sk_test",
      prefix: "wardo_sk_te",
      tenantId: "t1",
      apiKeyId: "k1",
    });
  });
  const res = await app.request("/request-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "my-agent" }),
  });
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.apiKey, "wardo_sk_test");
  assertEquals(body.prefix, "wardo_sk_te");
  assertEquals(seenLabel, "my-agent");
});

Deno.test("POST /request-key works with no body (anonymous)", async () => {
  const app = appWith(() =>
    Promise.resolve({
      token: "wardo_sk_anon",
      prefix: "wardo_sk_an",
      tenantId: "t",
      apiKeyId: "k",
    })
  );
  const res = await app.request("/request-key", { method: "POST" });
  assertEquals(res.status, 201);
  assertEquals((await res.json()).apiKey, "wardo_sk_anon");
});

Deno.test("POST /request-key surfaces db_required as 503", async () => {
  const app = appWith(() =>
    Promise.reject(new Error("api_keys_db_required: no DATABASE_URL"))
  );
  const res = await app.request("/request-key", { method: "POST" });
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error, "db_required");
});
