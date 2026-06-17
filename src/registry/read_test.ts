import { assertEquals, assertRejects } from "@std/assert";
import { closeDb, dbEnabled, getDb } from "../db/client.ts";
import { getActiveServices, getRecipe } from "./read.ts";

const HAS_DB = dbEnabled();

// ── getRecipe ────────────────────────────────────────────────────────────────

Deno.test("getRecipe — returns recipe for known service_id", async () => {
  const recipe = await getRecipe("2cd85635");
  assertEquals(recipe.service_id, "2cd85635");
  assertEquals(recipe.category, "sanctions");
  assertEquals(recipe.method, "GET");
});

Deno.test("getRecipe — throws for unknown service_id", async () => {
  await assertRejects(
    () => getRecipe("deadbeef"),
    Error,
    "no recipe found for service_id: deadbeef",
  );
});

// ── getActiveServices ─────────────────────────────────────────────────────────

Deno.test({
  name: "getActiveServices — returns seeded entries filtered by category",
  ignore: !HAS_DB,
  async fn() {
    const db = getDb();
    // Insert two test rows under distinct categories.
    await db`
      INSERT INTO service_registry (resource, category, price_usdc, status, source, score, last_vetted_at)
      VALUES
        ('https://test.example/sanctions', 'sanctions', 0.001, 'active', 'test-sanct', 1.0, now()),
        ('https://test.example/labels',    'labels',    0.005, 'active', 'test-label', 0.9, now())
      ON CONFLICT (resource) DO UPDATE SET
        status         = 'active',
        source         = EXCLUDED.source,
        score          = EXCLUDED.score,
        last_vetted_at = now(),
        updated_at     = now()
    `;
    try {
      const sanctions = await getActiveServices("sanctions");
      const testRow = sanctions.find((e) => e.service_id === "test-sanct");
      assertEquals(testRow?.resource, "https://test.example/sanctions");
      assertEquals(testRow?.price_usdc, 0.001);
      assertEquals(testRow?.score, 1.0);
      assertEquals(testRow?.status, "active");

      // The labels row must not appear in a sanctions-filtered query.
      const labelIds = sanctions.map((e) => e.service_id);
      assertEquals(labelIds.includes("test-label"), false);
    } finally {
      await db`DELETE FROM service_registry WHERE source IN ('test-sanct', 'test-label')`;
      await closeDb();
    }
  },
});

Deno.test({
  name: "getActiveServices — no category returns all active entries",
  ignore: !HAS_DB,
  async fn() {
    const db = getDb();
    await db`
      INSERT INTO service_registry (resource, category, price_usdc, status, source, score, last_vetted_at)
      VALUES
        ('https://test.example/s1', 'sanctions', 0.001, 'active',  'ts1', 1.0, now()),
        ('https://test.example/s2', 'labels',    0.005, 'blocked', 'ts2', 0.5, now())
      ON CONFLICT (resource) DO UPDATE SET
        status         = EXCLUDED.status,
        source         = EXCLUDED.source,
        score          = EXCLUDED.score,
        last_vetted_at = now(),
        updated_at     = now()
    `;
    try {
      const all = await getActiveServices();
      const ids = all.map((e) => e.service_id);
      // ts1 is active — must appear; ts2 is blocked — must not.
      assertEquals(ids.includes("ts1"), true);
      assertEquals(ids.includes("ts2"), false);
    } finally {
      await db`DELETE FROM service_registry WHERE source IN ('ts1', 'ts2')`;
      await closeDb();
    }
  },
});
