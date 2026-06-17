import { assertEquals } from "@std/assert";
import { dbEnabled } from "../db/client.ts";
import {
  _resetHealthStoreForTests,
  failureRate,
  isDurablyBlocked,
  isQualityDemoted,
  readHealth,
  recordEmptyOnRich,
  recordError,
  recordOk,
  resetEmptyOnRich,
} from "./health_store.ts";

// ---------------------------------------------------------------------------
// Helper: run fn with DATABASE_URL unset so the in-memory path is taken.
// ---------------------------------------------------------------------------
async function withMemoryStore(fn: () => Promise<void>) {
  const savedUrl = Deno.env.get("DATABASE_URL");
  Deno.env.delete("DATABASE_URL");
  await _resetHealthStoreForTests();
  try {
    await fn();
  } finally {
    if (savedUrl) Deno.env.set("DATABASE_URL", savedUrl);
    await _resetHealthStoreForTests();
  }
}

// ---------------------------------------------------------------------------
// Offline tests — always run, use in-memory fallback
// ---------------------------------------------------------------------------

Deno.test(
  "[offline] recordOk increments ok counter in memory",
  async () => {
    await withMemoryStore(async () => {
      await recordOk("https://svc.a");
      const all = await readHealth();
      assertEquals(all["https://svc.a"]?.ok, 1);
    });
  },
);

Deno.test(
  "[offline] recordError increments err and stores code in memory",
  async () => {
    await withMemoryStore(async () => {
      await recordError("https://svc.b", "Not Found", "not_found");
      const all = await readHealth();
      assertEquals(all["https://svc.b"]?.err, 1);
      assertEquals(all["https://svc.b"]?.lastErrorCode, "not_found");
    });
  },
);

Deno.test(
  "[offline] isDurablyBlocked true after durable error code",
  async () => {
    await withMemoryStore(async () => {
      await recordError(
        "https://svc.blocked",
        "literal placeholder in URL",
        "unsubstituted_path_param",
      );
      assertEquals(await isDurablyBlocked("https://svc.blocked"), true);
    });
  },
);

Deno.test(
  "[offline] isDurablyBlocked false for transient error",
  async () => {
    await withMemoryStore(async () => {
      await recordError("https://svc.transient", "boom", "upstream_500");
      assertEquals(await isDurablyBlocked("https://svc.transient"), false);
    });
  },
);

Deno.test(
  "[offline] emptyOnRich counter triggers quality demotion at threshold 3",
  async () => {
    await withMemoryStore(async () => {
      const r = "https://lbl.weak";
      await recordEmptyOnRich(r);
      assertEquals(await isQualityDemoted(r), false);
      await recordEmptyOnRich(r);
      assertEquals(await isQualityDemoted(r), false);
      await recordEmptyOnRich(r);
      assertEquals(await isQualityDemoted(r), true);
    });
  },
);

Deno.test(
  "[offline] resetEmptyOnRich clears demotion",
  async () => {
    await withMemoryStore(async () => {
      const r = "https://lbl.recovering";
      await recordEmptyOnRich(r);
      await recordEmptyOnRich(r);
      await recordEmptyOnRich(r);
      assertEquals(await isQualityDemoted(r), true);
      await resetEmptyOnRich(r);
      assertEquals(await isQualityDemoted(r), false);
    });
  },
);

Deno.test(
  "[offline] failureRate returns null for unseen resource",
  async () => {
    await withMemoryStore(async () => {
      assertEquals(await failureRate("https://never-seen.example"), null);
    });
  },
);

Deno.test(
  "[offline] failureRate computes correctly",
  async () => {
    await withMemoryStore(async () => {
      const r = "https://svc.mixed";
      await recordOk(r);
      await recordOk(r);
      await recordOk(r);
      await recordError(r, "transient");
      // 1 err / 4 total = 0.25
      assertEquals(await failureRate(r), 0.25);
    });
  },
);

// ---------------------------------------------------------------------------
// DB tests — gated on DATABASE_URL
// ---------------------------------------------------------------------------

Deno.test({
  name: "[db] mark service blocked, simulate restart, verify still blocked",
  ignore: !dbEnabled(),
  async fn() {
    await _resetHealthStoreForTests();
    const url = "https://svc.db-blocked";
    await recordError(url, "Not Found", "not_found");
    // Simulate cold-start: wipe in-memory state only.
    await _resetHealthStoreForTests();
    // DB path should still return true because the row persists.
    assertEquals(await isDurablyBlocked(url), true);
  },
});

Deno.test({
  name: "[db] emptyOnRich counter persists across restarts",
  ignore: !dbEnabled(),
  async fn() {
    await _resetHealthStoreForTests();
    const r = "https://lbl.db-weak";
    await recordEmptyOnRich(r);
    await recordEmptyOnRich(r);
    await recordEmptyOnRich(r);
    // Simulate cold-start.
    await _resetHealthStoreForTests();
    assertEquals(await isQualityDemoted(r), true);
  },
});
