import { assertEquals } from "@std/assert";
import { noopEmit, safeEmit, type VerifyEvent } from "./events.ts";

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

Deno.test("noopEmit accepts every variant without throwing", () => {
  const variants: VerifyEvent[] = [
    { type: "phase", phase: "discover", status: "start", at: "t" },
    { type: "log", level: "warn", message: "m", at: "t" },
    {
      type: "service",
      status: "ok",
      category: "sanctions",
      resource: "https://x",
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
