import { assertEquals } from "@std/assert";
import { app } from "./main.ts";
import { closeDb, dbEnabled } from "./db/client.ts";

// The "db: ok" case needs a real database; it self-skips when DATABASE_URL is
// unset so `deno task test` stays offline-safe (mirrors src/db/client_test.ts).
const HAS_DB = dbEnabled();

Deno.test("GET /health reports db: disabled when DATABASE_URL unset", async () => {
  const prev = Deno.env.get("DATABASE_URL");
  Deno.env.delete("DATABASE_URL");
  await closeDb();
  try {
    const res = await app.request("/health");
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { status: "ok", db: "disabled" });
  } finally {
    await closeDb();
    if (prev !== undefined) Deno.env.set("DATABASE_URL", prev);
  }
});

Deno.test({
  name: "GET /health reports db: ok against a live database",
  ignore: !HAS_DB,
  async fn() {
    await closeDb();
    try {
      const res = await app.request("/health");
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { status: "ok", db: "ok" });
    } finally {
      await closeDb();
    }
  },
});
