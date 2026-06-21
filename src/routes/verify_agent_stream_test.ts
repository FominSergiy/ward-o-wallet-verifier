import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { createVerifyAgentStreamRouter } from "./verify_agent_stream.ts";
import type { AgnicBudget } from "../discovery/network.ts";
import type { VerifyAgentResult } from "../agent/verify.ts";
import type { EventEmitter } from "../agent/events.ts";

interface ParsedFrame {
  event: string;
  data: string;
}

async function readSSEFrames(res: Response): Promise<ParsedFrame[]> {
  const text = await res.text();
  // Each frame is delimited by a blank line. Filter out the ping comment-only
  // frames (we don't emit any in these tests).
  const frames: ParsedFrame[] = [];
  for (const block of text.split(/\n\n+/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    frames.push({ event, data: dataLines.join("\n") });
  }
  return frames;
}

function buildApp(opts: {
  budget?: AgnicBudget | null | (() => Promise<AgnicBudget | null>);
  verifyAgentFn?: (
    req: { address: string },
    options: { onEvent?: EventEmitter; budgetCeiling?: number },
  ) => Promise<VerifyAgentResult>;
}): Hono {
  const app = new Hono();
  const budget = opts.budget ?? null;
  const router = createVerifyAgentStreamRouter({
    budgetFetcher: typeof budget === "function"
      ? budget
      : () => Promise.resolve(budget),
    verifyAgentFn: opts.verifyAgentFn as
      | typeof import("../agent/verify.ts").verifyAgent
      | undefined,
  });
  app.route("/verify-agent-stream", router);
  return app;
}

function fakeResult(): VerifyAgentResult {
  return {
    verdict: {
      address: "0xABC0000000000000000000000000000000000123",
      chain: "base",
      safe: true,
      verdict: "safe_to_transact",
      confidence: "high",
      headline: "ok",
      reasoning: "ok",
      findings: [],
      coverage: { requested: [], resolved: [], unresolved: [] },
      totalSpentUsdc: 0.001,
      generatedAt: new Date().toISOString(),
    },
    plan: {
      address: "0xABC0000000000000000000000000000000000123",
      walletNetwork: "base",
      services: [{
        category: "sanctions",
        resource: "https://sanc.example",
        description: "x",
        priceUsdc: 0.001,
        network: "eip155:8453",
        payTo: "0xp",
        scheme: "exact",
        qualityScore: null,
        rationale: "r",
      }],
      alternates: {},
      totalEstimatedCostUsdc: 0.001,
      unresolvedCategories: [],
      deterministicSources: [],
      generatedAt: new Date().toISOString(),
    },
    outcomes: [{
      category: "sanctions",
      resource: "https://sanc.example",
      data: { sanctions_match: false },
      status: "ok",
      amountUsdc: 0.001,
      durationMs: 5,
      paid: true,
      network: "base",
      adapterPath: "pattern",
    }],
    walletNetwork: "base",
    totalSpentUsdc: 0.001,
    totalLlmCostUsd: 0.0002,
  };
}

Deno.test("POST /verify-agent-stream streams phase, plan, service, result events in order", async () => {
  const app = buildApp({
    budget: { usdcBalance: 10, creditBalance: 10, totalBalance: 20 },
    verifyAgentFn: (_req, opts) => {
      const emit = opts.onEvent!;
      // Canned event script mirroring the real pipeline shape.
      const rid = "00000000-0000-0000-0000-000000000000";
      emit({
        type: "phase",
        phase: "discover",
        status: "start",
        request_id: rid,
        duration_ms: 0,
        at: "t",
      });
      emit({
        type: "plan",
        services: [
          {
            category: "sanctions",
            resource: "https://sanc.example",
            priceUsdc: 0.001,
            rationale: "r",
          },
        ],
        totalEstimatedCostUsdc: 0.001,
        walletNetwork: "base",
        at: "t",
      });
      emit({
        type: "phase",
        phase: "discover",
        status: "end",
        request_id: rid,
        duration_ms: 10,
        at: "t",
      });
      emit({
        type: "phase",
        phase: "invoke",
        status: "start",
        request_id: rid,
        duration_ms: 0,
        at: "t",
      });
      emit({
        type: "service",
        status: "start",
        category: "sanctions",
        resource: "https://sanc.example",
        priceUsdc: 0.001,
        request_id: rid,
        duration_ms: 0,
        cost_usd: null,
        at: "t",
      });
      emit({
        type: "service",
        status: "ok",
        category: "sanctions",
        resource: "https://sanc.example",
        priceUsdc: 0.001,
        amountUsdc: 0.001,
        request_id: rid,
        duration_ms: 5,
        cost_usd: 0.001,
        at: "t",
      });
      emit({
        type: "phase",
        phase: "invoke",
        status: "end",
        request_id: rid,
        duration_ms: 20,
        at: "t",
      });
      emit({
        type: "phase",
        phase: "synthesize",
        status: "start",
        request_id: rid,
        duration_ms: 0,
        at: "t",
      });
      emit({
        type: "phase",
        phase: "synthesize",
        status: "end",
        request_id: rid,
        duration_ms: 30,
        at: "t",
      });
      return Promise.resolve(fakeResult());
    },
  });
  const res = await app.request("/verify-agent-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: "0xABC0000000000000000000000000000000000123",
    }),
  });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/event-stream");

  const frames = await readSSEFrames(res);
  const eventNames = frames.map((f) => f.event);
  // The route must finish with a result frame.
  assertEquals(eventNames[eventNames.length - 1], "result");
  // Phase + plan + service events appear in order.
  assertEquals(eventNames[0], "phase");
  assertEquals(eventNames.includes("plan"), true);
  assertEquals(eventNames.includes("service"), true);
  // No error frames.
  assertEquals(eventNames.includes("error"), false);

  // Parse the result frame.
  const resultFrame = frames[frames.length - 1];
  const resultBody = JSON.parse(resultFrame.data) as {
    type: string;
    payload: {
      walletNetwork: string;
      totalSpentUsdc: number;
      totalLlmCostUsd: number;
    };
  };
  assertEquals(resultBody.type, "result");
  assertEquals(resultBody.payload.walletNetwork, "base");
  assertEquals(resultBody.payload.totalSpentUsdc, 0.001);
  assertEquals(resultBody.payload.totalLlmCostUsd, 0.0002);
});

Deno.test("POST /verify-agent-stream preflight budget exhausted emits one error event and ends", async () => {
  Deno.env.set("AGNIC_BUDGET_MIN_USD", "0.10");
  try {
    let verifyCalled = false;
    const app = buildApp({
      budget: { usdcBalance: 0.01, creditBalance: 0.01, totalBalance: 0.02 },
      verifyAgentFn: () => {
        verifyCalled = true;
        return Promise.resolve(fakeResult());
      },
    });
    const res = await app.request("/verify-agent-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "0xABC0000000000000000000000000000000000123",
        chain: "base",
      }),
    });
    assertEquals(res.status, 200);
    const frames = await readSSEFrames(res);
    assertEquals(frames.length, 1);
    assertEquals(frames[0].event, "error");
    const body = JSON.parse(frames[0].data) as {
      code: string;
      status: number;
    };
    assertEquals(body.code, "budget_exhausted");
    assertEquals(body.status, 503);
    assertEquals(verifyCalled, false);
  } finally {
    Deno.env.delete("AGNIC_BUDGET_MIN_USD");
  }
});

Deno.test("POST /verify-agent-stream WalletUnfundedError emits error event with code wallet_unfunded", async () => {
  const { WalletUnfundedError } = await import("../discovery/types.ts");
  const app = buildApp({
    budget: null,
    verifyAgentFn: () => Promise.reject(new WalletUnfundedError("0xA", "0xB")),
  });
  const res = await app.request("/verify-agent-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: "0xABC0000000000000000000000000000000000123",
    }),
  });
  assertEquals(res.status, 200);
  const frames = await readSSEFrames(res);
  const errFrame = frames.find((f) => f.event === "error");
  assertEquals(errFrame !== undefined, true);
  const body = JSON.parse(errFrame!.data) as { code: string };
  assertEquals(body.code, "wallet_unfunded");
});

Deno.test("POST /verify-agent-stream rejects malformed body with 400 before stream opens", async () => {
  const app = buildApp({ budget: null });
  const res = await app.request("/verify-agent-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: "not-an-address" }),
  });
  assertEquals(res.status, 400);
});
