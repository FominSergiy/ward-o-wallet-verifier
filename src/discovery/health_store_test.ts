import { assertEquals } from "@std/assert";
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

function withTempStore(fn: () => void) {
  const tmp = Deno.makeTempFileSync({ suffix: ".json" });
  Deno.env.set("HEALTH_STORE_PATH", tmp);
  Deno.env.delete("HEALTH_TRACKING"); // ensure ENABLED is true (env not "false")
  // Need to refresh module's ENABLED flag — but since it's module-level const,
  // we work around by ensuring the env var is set BEFORE the module sees it.
  // In practice the module reads ENABLED on import; tests run after import so
  // we can't change ENABLED. Instead we just ensure HEALTH_TRACKING is not "false".
  _resetHealthStoreForTests();
  try {
    fn();
  } finally {
    Deno.env.delete("HEALTH_STORE_PATH");
    try {
      Deno.removeSync(tmp);
    } catch {
      // ignore
    }
  }
}

Deno.test("recordOk and recordError persist across reads", () => {
  withTempStore(() => {
    recordOk("https://svc.a");
    recordOk("https://svc.a");
    recordError("https://svc.b", "Bad Request");
    const all = readHealth();
    assertEquals(all["https://svc.a"]?.ok, 2);
    assertEquals(all["https://svc.a"]?.err, 0);
    assertEquals(all["https://svc.b"]?.err, 1);
    assertEquals(all["https://svc.b"]?.lastError, "Bad Request");
  });
});

Deno.test("failureRate returns null for unseen resource", () => {
  withTempStore(() => {
    assertEquals(failureRate("https://never-called.example"), null);
  });
});

Deno.test("failureRate is 1.0 after a single error", () => {
  withTempStore(() => {
    recordError("https://svc.x", "boom");
    assertEquals(failureRate("https://svc.x"), 1.0);
  });
});

Deno.test("failureRate is 0.0 after a single ok", () => {
  withTempStore(() => {
    recordOk("https://svc.y");
    assertEquals(failureRate("https://svc.y"), 0.0);
  });
});

Deno.test("failureRate computes correctly with mixed history", () => {
  withTempStore(() => {
    recordOk("https://svc.z");
    recordOk("https://svc.z");
    recordOk("https://svc.z");
    recordError("https://svc.z", "transient");
    // 1 err / 4 total = 0.25
    assertEquals(failureRate("https://svc.z"), 0.25);
  });
});

Deno.test("recordError truncates very long error messages", () => {
  withTempStore(() => {
    const longMsg = "x".repeat(500);
    recordError("https://svc.q", longMsg);
    const stats = readHealth()["https://svc.q"];
    assertEquals(stats?.lastError?.length, 200);
  });
});

Deno.test("recordError persists lastErrorCode when provided", () => {
  withTempStore(() => {
    recordError("https://svc.p", "Payment Required", "payment_exceeds_max");
    const stats = readHealth()["https://svc.p"];
    assertEquals(stats?.lastErrorCode, "payment_exceeds_max");
  });
});

Deno.test("isDurablyBlocked returns true after payment_exceeds_max", () => {
  withTempStore(() => {
    recordError("https://svc.blocked", "Payment Required", "payment_exceeds_max");
    assertEquals(isDurablyBlocked("https://svc.blocked"), true);
  });
});

Deno.test("isDurablyBlocked returns true after not_found", () => {
  withTempStore(() => {
    recordError("https://svc.404", "Not Found", "not_found");
    assertEquals(isDurablyBlocked("https://svc.404"), true);
  });
});

Deno.test("isDurablyBlocked returns false for transient/generic errors", () => {
  withTempStore(() => {
    recordError("https://svc.transient", "boom", "upstream_500");
    recordError("https://svc.nocode", "boom");
    assertEquals(isDurablyBlocked("https://svc.transient"), false);
    assertEquals(isDurablyBlocked("https://svc.nocode"), false);
    assertEquals(isDurablyBlocked("https://svc.unseen"), false);
  });
});

Deno.test("recordEmptyOnRich accumulates and isQualityDemoted triggers after 3 hits", () => {
  withTempStore(() => {
    const r = "https://lbl.weak";
    recordEmptyOnRich(r);
    assertEquals(isQualityDemoted(r), false);
    recordEmptyOnRich(r);
    assertEquals(isQualityDemoted(r), false);
    recordEmptyOnRich(r);
    assertEquals(isQualityDemoted(r), true);
  });
});

Deno.test("resetEmptyOnRich clears the counter and removes demotion", () => {
  withTempStore(() => {
    const r = "https://lbl.recovering";
    recordEmptyOnRich(r);
    recordEmptyOnRich(r);
    recordEmptyOnRich(r);
    assertEquals(isQualityDemoted(r), true);
    resetEmptyOnRich(r);
    assertEquals(isQualityDemoted(r), false);
  });
});

Deno.test("isQualityDemoted is false for an untouched resource", () => {
  withTempStore(() => {
    assertEquals(isQualityDemoted("https://nobody-has-tested-this"), false);
  });
});

Deno.test("isQualityDemoted is false when emptyOnRichAt is older than 7 days", () => {
  withTempStore(() => {
    const r = "https://lbl.stale";
    recordEmptyOnRich(r);
    recordEmptyOnRich(r);
    recordEmptyOnRich(r);
    // Manually backdate the timestamp to 8 days ago.
    const stats = readHealth()[r];
    stats.emptyOnRichAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
      .toISOString();
    const updated = readHealth();
    updated[r] = stats;
    Deno.writeTextFileSync(
      Deno.env.get("HEALTH_STORE_PATH")!,
      JSON.stringify(updated, null, 2),
    );
    assertEquals(isQualityDemoted(r), false);
  });
});
