import { assert, assertEquals, assertMatch } from "@std/assert";
import { log } from "./log.ts";

function capture(method: "log" | "warn" | "error", fn: () => void): unknown[] {
  const original = console[method];
  const calls: unknown[][] = [];
  console[method] = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    fn();
  } finally {
    console[method] = original;
  }
  return calls.length > 0 ? calls[0] : [];
}

Deno.test("log.error: formats as `<iso> ERROR <message>` and keeps rest args", () => {
  const cause = new Error("boom");
  const [line, ...rest] = capture(
    "error",
    () => log.error("[x] failed", cause),
  );
  assertMatch(
    line as string,
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ERROR \[x\] failed$/,
  );
  assertEquals(rest, [cause]);
});

Deno.test("log.warn: routes to console.warn with WARN level", () => {
  const [line] = capture("warn", () => log.warn("heads up"));
  assertMatch(line as string, / WARN heads up$/);
});

Deno.test("log.info: routes to console.log with INFO level", () => {
  const [line] = capture("log", () => log.info("fyi"));
  assertMatch(line as string, / INFO fyi$/);
});

Deno.test("log.debug: suppressed at the default (info) threshold", () => {
  // Only meaningful when LOG_LEVEL isn't explicitly lowered to debug.
  if ((Deno.env.get("LOG_LEVEL") ?? "info").toLowerCase() === "debug") return;
  const out = capture("log", () => log.debug("noisy"));
  assert(out.length === 0, "debug should not emit at info threshold");
});
