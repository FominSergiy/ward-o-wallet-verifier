import { assertEquals } from "@std/assert";
import { recordUsageEvent } from "./usage.ts";
import { runWithRequestContext } from "./request_context.ts";
import { log } from "./log.ts";
import type { Db } from "../db/client.ts";

// A fake tagged-template DB that captures the interpolated values of each
// INSERT instead of touching a real socket. The values land in the order they
// appear in the template:
//   [tenant_id, request_id, route, phase, duration_ms, cost_usd, verdict]
function makeFakeDb(
  result: () => Promise<unknown> = () => Promise.resolve([]),
): { db: Db; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const db = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return result();
  }) as unknown as Db;
  return { db, calls };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("recordUsageEvent: writes one row with request_id, route, verdict, cost_usd on a terminal run", () => {
  const { db, calls } = makeFakeDb();
  recordUsageEvent({
    request_id: "req-usage-1",
    route: "verify-agent",
    verdict: "safe_to_transact",
    cost_usd: 0.012,
  }, db);

  assertEquals(calls.length, 1, "exactly one INSERT");
  const [tenantId, requestId, route, phase, durationMs, costUsd, verdict] =
    calls[0];
  assertEquals(requestId, "req-usage-1");
  assertEquals(route, "verify-agent");
  assertEquals(verdict, "safe_to_transact");
  // postgres.js numeric() round-trips as a string; the writer normalizes cost.
  assertEquals(costUsd, "0.012");
  // tenant null + phase/duration omitted → null, not undefined.
  assertEquals(tenantId, null);
  assertEquals(phase, null);
  assertEquals(durationMs, null);
});

Deno.test("recordUsageEvent: sets tenant_id from ambient context when keyed; NULL when anonymous", () => {
  // Anonymous — no surrounding context.
  const anon = makeFakeDb();
  recordUsageEvent({
    request_id: "req-anon",
    route: "verify-agent",
    verdict: "insufficient_data",
    cost_usd: null,
  }, anon.db);
  assertEquals(anon.calls[0][0], null, "anonymous → tenant_id NULL");
  assertEquals(anon.calls[0][5], null, "null cost stays NULL");

  // Keyed — inside a bound request context.
  const keyed = makeFakeDb();
  runWithRequestContext("key-x", "tenant-x", () => {
    recordUsageEvent({
      request_id: "req-keyed",
      route: "mcp:get_deep_verdict",
      verdict: "do_not_transact",
      cost_usd: 0.02,
    }, keyed.db);
  });
  assertEquals(keyed.calls[0][0], "tenant-x", "keyed → tenant_id from context");
  assertEquals(keyed.calls[0][2], "mcp:get_deep_verdict");
});

Deno.test("recordUsageEvent: never throws and logs once when the insert rejects", async () => {
  const { db } = makeFakeDb(() => Promise.reject(new Error("db down")));
  const origError = log.error;
  let errorCalls = 0;
  log.error = () => {
    errorCalls++;
  };
  try {
    // Must not throw synchronously…
    recordUsageEvent({
      request_id: "req-reject",
      route: "verify-agent",
      verdict: "safe_to_transact",
      cost_usd: 0.01,
    }, db);
    // …and the rejection must be swallowed + logged exactly once.
    await tick();
    assertEquals(errorCalls, 1);
  } finally {
    log.error = origError;
  }
});

Deno.test("recordUsageEvent: does not write before a terminal verdict", () => {
  const { db, calls } = makeFakeDb();
  recordUsageEvent({
    request_id: "req-inflight",
    route: "verify-agent",
    verdict: null,
    cost_usd: null,
    terminal: false,
  }, db);
  assertEquals(calls.length, 0, "non-terminal event writes nothing");
});
