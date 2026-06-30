import { assertEquals } from "@std/assert";
import { authorizeMcp } from "./http.ts";
import type { ResolvedKey } from "../auth/api_keys.ts";

const noLookup = (_t: string): Promise<ResolvedKey | null> =>
  Promise.resolve(null);

Deno.test("authorizeMcp: disabled when neither secret nor db is configured", async () => {
  const a = await authorizeMcp({
    bearer: "x",
    secret: undefined,
    dbConfigured: false,
    lookup: noLookup,
  });
  assertEquals(a.kind, "disabled");
});

Deno.test("authorizeMcp: admin shared secret authorizes with null apiKeyId", async () => {
  const a = await authorizeMcp({
    bearer: "s3cret",
    secret: "s3cret",
    dbConfigured: false,
    lookup: noLookup,
  });
  assertEquals(a, { kind: "ok", apiKeyId: null });
});

Deno.test("authorizeMcp: a valid issued key authorizes with its id", async () => {
  const lookup = (t: string): Promise<ResolvedKey | null> =>
    Promise.resolve(
      t === "wardo_sk_good" ? { id: "key-1", tenantId: "t" } : null,
    );
  const a = await authorizeMcp({
    bearer: "wardo_sk_good",
    secret: undefined,
    dbConfigured: true,
    lookup,
  });
  assertEquals(a, { kind: "ok", apiKeyId: "key-1" });
});

Deno.test("authorizeMcp: an unknown bearer is unauthorized", async () => {
  const a = await authorizeMcp({
    bearer: "wardo_sk_bad",
    secret: undefined,
    dbConfigured: true,
    lookup: noLookup,
  });
  assertEquals(a.kind, "unauthorized");
});

Deno.test("authorizeMcp: empty bearer (while enabled) is unauthorized", async () => {
  const a = await authorizeMcp({
    bearer: "",
    secret: "s",
    dbConfigured: false,
    lookup: noLookup,
  });
  assertEquals(a.kind, "unauthorized");
});
