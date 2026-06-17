import { assertEquals } from "@std/assert";
import { closeDb, type Db, dbEnabled, getDb, type NoopDb } from "./client.ts";
import type { UsageEventRow } from "./types.ts";

// The round-trip / idempotency tests need a real database. They self-skip when
// DATABASE_URL is unset so `deno task test` stays offline-safe.
const HAS_DB = dbEnabled();

function isNoop(db: Db): db is NoopDb {
  return (db as NoopDb).noop === true;
}

Deno.test("getDb returns no-op client when DATABASE_URL unset", async () => {
  const prev = Deno.env.get("DATABASE_URL");
  Deno.env.delete("DATABASE_URL");
  await closeDb();
  try {
    const db = getDb();
    assertEquals(isNoop(db), true);
    // A query resolves to an empty result and opens no socket.
    const rows = await (db as NoopDb)`SELECT 1`;
    assertEquals(rows, []);
  } finally {
    await closeDb();
    if (prev !== undefined) Deno.env.set("DATABASE_URL", prev);
  }
});

Deno.test({
  name: "usage_events round-trip",
  ignore: !HAS_DB,
  async fn() {
    await closeDb();
    const sql = getDb() as Exclude<Db, NoopDb>;
    const requestId = `test-${crypto.randomUUID()}`;
    try {
      await sql`
        INSERT INTO usage_events (request_id, route, phase, duration_ms, cost_usd)
        VALUES (${requestId}, ${"/verify-agent"}, ${"synthesize"}, ${1234}, ${"0.05000000"})
      `;
      const rows = await sql<UsageEventRow[]>`
        SELECT request_id, route, phase, duration_ms, cost_usd
        FROM usage_events WHERE request_id = ${requestId}
      `;
      assertEquals(rows.length, 1);
      const row = rows[0];
      assertEquals(row.request_id, requestId);
      assertEquals(row.route, "/verify-agent");
      assertEquals(row.phase, "synthesize");
      assertEquals(row.duration_ms, 1234);
      assertEquals(row.cost_usd, "0.05000000");
    } finally {
      await sql`DELETE FROM usage_events WHERE request_id = ${requestId}`;
      await closeDb();
    }
  },
});

Deno.test({
  name: "migration idempotency",
  ignore: !HAS_DB,
  async fn() {
    const { migrate } = await import("../../scripts/migrate.ts");
    const url = Deno.env.get("DATABASE_URL")!;
    // First call may or may not apply (depending on prior state); second call
    // must be a no-op, and schema_migrations holds exactly one row for 0001.
    await migrate(url);
    const secondPass = await migrate(url);
    assertEquals(secondPass, []);

    await closeDb();
    const sql = getDb() as Exclude<Db, NoopDb>;
    try {
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM schema_migrations WHERE version = ${"0001"}
      `;
      assertEquals(rows[0].count, "1");
    } finally {
      await closeDb();
    }
  },
});
