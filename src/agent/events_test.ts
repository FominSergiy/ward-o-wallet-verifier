import { assertEquals } from "@std/assert";
import { noopEmit, safeEmit, type VerifyEvent } from "./events.ts";

const TEST_REQUEST_ID = "00000000-0000-0000-0000-000000000000";

Deno.test("discriminated union narrows by type field", () => {
  // Compile-time test: exhaustive switch must produce a `never` in default.
  function describe(e: VerifyEvent): string {
    switch (e.type) {
      case "phase":
        return `phase:${e.phase}:${e.status}`;
      case "log":
        return `log:${e.level}`;
      case "service":
        return `service:${e.status}:${e.category}`;
      case "plan":
        return `plan:${e.services.length}`;
      case "result":
        return "result";
      case "error":
        return `error:${e.code}`;
      default: {
        const _exhaustive: never = e;
        return _exhaustive;
      }
    }
  }
  assertEquals(
    describe({ type: "log", level: "info", message: "hi", at: "t" }),
    "log:info",
  );
});

Deno.test("ServiceEvent requires request_id and duration_ms", () => {
  // Compile-time shape test — if these fields are missing, TS will error.
  const e: VerifyEvent = {
    type: "service",
    status: "ok",
    category: "sanctions",
    resource: "https://x",
    request_id: TEST_REQUEST_ID,
    duration_ms: 42,
    cost_usd: 0.001,
    at: "t",
  };
  assertEquals(e.type, "service");
});

Deno.test("LogEvent level=error requires code", () => {
  // Compile-time test — omitting code on an error-level log is a TS error.
  const e: VerifyEvent = {
    type: "log",
    level: "error",
    code: "synthesis_failed",
    message: "something went wrong",
    at: "t",
  };
  assertEquals(e.type, "log");
});

Deno.test("LogEvent level=error events have code set", () => {
  const events: VerifyEvent[] = [];
  const emit = (e: VerifyEvent) => events.push(e);
  emit({
    type: "log",
    level: "error",
    code: "test_error",
    message: "test",
    at: "t",
  });
  const err = events[0];
  // Narrow to log+error to access code
  if (err.type === "log" && err.level === "error") {
    assertEquals(typeof err.code, "string");
  } else {
    throw new Error("expected error log event");
  }
});

Deno.test("noopEmit accepts every variant without throwing", () => {
  const variants: VerifyEvent[] = [
    {
      type: "phase",
      phase: "discover",
      status: "start",
      request_id: TEST_REQUEST_ID,
      duration_ms: 0,
      at: "t",
    },
    { type: "log", level: "warn", message: "m", at: "t" },
    {
      type: "service",
      status: "ok",
      category: "sanctions",
      resource: "https://x",
      request_id: TEST_REQUEST_ID,
      duration_ms: 10,
      cost_usd: 0.001,
      at: "t",
    },
    {
      type: "plan",
      services: [],
      totalEstimatedCostUsdc: 0,
      walletNetwork: "base",
      at: "t",
    },
    { type: "result", payload: {}, at: "t" },
    { type: "error", code: "x", message: "m", at: "t" },
  ];
  for (const v of variants) noopEmit(v);
});

Deno.test("safeEmit swallows consumer exceptions", () => {
  let called = 0;
  const throwing = () => {
    called++;
    throw new Error("consumer blew up");
  };
  safeEmit(throwing, {
    type: "log",
    level: "info",
    message: "m",
    at: "t",
  });
  safeEmit(undefined, {
    type: "log",
    level: "info",
    message: "m",
    at: "t",
  });
  assertEquals(called, 1);
});

Deno.test("all events from a verify run share the same request_id", async () => {
  // Integration test: collect events and verify request_id coherence.
  const { verifyAgent } = await import("./verify.ts");
  const { type: _t, ...types } = { type: "chain" } as { type: string };
  void types;

  const collected: VerifyEvent[] = [];
  const onEvent = (e: VerifyEvent) => collected.push(e);

  const fakeOracle = (_addr: string, chain: string) =>
    Promise.resolve({
      source: "chainalysis_oracle" as const,
      oracleAddress: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
      chain: chain as "eth",
      isSanctioned: false,
      checkedAt: new Date().toISOString(),
      rpcUrl: "https://test.rpc",
    });

  const fakePlan = {
    address: "0xABC",
    walletNetwork: "base" as const,
    services: [],
    alternates: {},
    totalEstimatedCostUsdc: 0,
    unresolvedCategories: [],
    deterministicSources: [],
    generatedAt: new Date().toISOString(),
  };

  const fakeVerdict = {
    address: "0xABC",
    chain: "eth" as const,
    safe: true,
    verdict: "safe_to_transact" as const,
    confidence: "high" as const,
    headline: "ok",
    reasoning: "ok",
    findings: [],
    coverage: { requested: [], resolved: [], unresolved: [] },
    totalSpentUsdc: 0,
    generatedAt: new Date().toISOString(),
  };

  const THE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  await verifyAgent(
    { address: "0xABC" },
    {
      request_id: THE_ID,
      onEvent,
      categories: ["sanctions"],
      _testHooks: {
        checkSanctionsOracle: fakeOracle,
        selectFromRegistry: () => Promise.resolve(fakePlan),
        // deno-lint-ignore no-explicit-any
        invokeAll: () =>
          Promise.resolve({
            findings: { sanctions: { ok: true } },
            outcomes: [],
            unresolved: [],
            totalSpentUsdc: 0,
            walletNetwork: "base" as const,
          }) as any,
        synthesizeVerdict: () => Promise.resolve(fakeVerdict),
        resolveEns: () =>
          Promise.resolve({
            source: "viem_ens" as const,
            chain: "eth" as const,
            address: "0xABC",
            ensName: null,
            rpcUrl: "https://test.rpc",
            checkedAt: new Date().toISOString(),
          }),
      },
    },
  );

  // All phase and service events must carry THE_ID.
  const traceable = collected.filter(
    (e) => e.type === "phase" || e.type === "service",
  );
  assertEquals(traceable.length > 0, true);
  for (const e of traceable) {
    if (e.type === "phase" || e.type === "service") {
      assertEquals(
        e.request_id,
        THE_ID,
        `expected ${THE_ID} but got ${e.request_id} on ${e.type} event`,
      );
    }
  }
});
