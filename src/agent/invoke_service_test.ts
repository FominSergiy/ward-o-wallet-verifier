import { assertEquals } from "@std/assert";
import { z } from "zod";
import { invokeRankedService } from "./invoke_service.ts";
import { mockLlm, type LlmClient } from "./llm.ts";
import type { RankedService } from "../discovery/types.ts";

const ADDR = "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2";

function svc(args: Partial<RankedService> = {}): RankedService {
  return {
    category: args.category ?? "sanctions",
    resource: args.resource ?? "https://svc.example/v1/screen",
    description: args.description ?? "x",
    priceUsdc: args.priceUsdc ?? 0.001,
    network: "eip155:8453",
    payTo: "0xpay",
    scheme: "exact",
    qualityScore: null,
    rationale: "r",
    inputInfo: args.inputInfo ?? { method: "GET", queryParams: { wallet: "0xexample" } },
  };
}

function captureConsole() {
  const warn: string[] = [];
  const error: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args: unknown[]) => {
    warn.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    error.push(args.map(String).join(" "));
  };
  const restore = () => {
    console.warn = origWarn;
    console.error = origError;
  };
  return { warn, error, restore };
}

function setupAgnic(envKey = "test-key") {
  Deno.env.set("AGNIC_API_KEY", envKey);
}

function teardownAgnic() {
  Deno.env.delete("AGNIC_API_KEY");
}

function jsonResp(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

Deno.test("invokeRankedService succeeds via pattern-match", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (_url, _init) => {
    calls++;
    return Promise.resolve(jsonResp(200, { sanctions_match: false }, {
      "X-Agnic-Paid": "true",
      "X-Agnic-Amount": "0.001",
      "X-Agnic-Network": "base",
      "X-Agnic-Scheme": "exact",
    }));
  };
  const llmCalls = { n: 0 };
  const llm: LlmClient = {
    generateStructured<T>(schema: z.ZodType<T>, _p: string): Promise<T> {
      llmCalls.n++;
      return Promise.resolve(schema.parse({ url: "https://x", method: "GET" }));
    },
  };
  try {
    const out = await invokeRankedService(svc(), ADDR, "base", { llm });
    assertEquals(out.status, "ok");
    assertEquals(out.adapterPath, "pattern");
    assertEquals(out.amountUsdc, 0.001);
    assertEquals(out.paid, true);
    assertEquals(calls, 1);
    assertEquals(llmCalls.n, 0); // LLM never invoked
  } finally {
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService falls back to LLM on bad upstream response", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const cap = captureConsole();
  let call = 0;
  globalThis.fetch = (_url, _init) => {
    call++;
    if (call === 1) {
      return Promise.resolve(
        jsonResp(400, { error: "upstream_4xx", error_description: "missing wallet param" }),
      );
    }
    return Promise.resolve(jsonResp(200, { sanctions_match: false }, {
      "X-Agnic-Paid": "true",
      "X-Agnic-Amount": "0.001",
    }));
  };
  let llmCalls = 0;
  const llm: LlmClient = {
    generateStructured<T>(schema: z.ZodType<T>, _p: string): Promise<T> {
      llmCalls++;
      return Promise.resolve(
        schema.parse({ url: "https://svc.example/v1/screen?wallet=" + ADDR, method: "GET" }),
      );
    },
  };
  try {
    const out = await invokeRankedService(svc(), ADDR, "base", { llm });
    assertEquals(out.status, "fallback_ok");
    assertEquals(out.adapterPath, "llm");
    assertEquals(llmCalls, 1);
    assertEquals(call, 2);
    assertEquals(cap.warn.length >= 1, true);
    assertEquals(cap.warn[0].includes("pattern-match failed"), true);
  } finally {
    cap.restore();
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService surfaces error when both adapters fail", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const cap = captureConsole();
  globalThis.fetch = (_url, _init) =>
    Promise.resolve(
      jsonResp(400, { error: "upstream_4xx", error_description: "bad request" }),
    );
  const llm: LlmClient = {
    generateStructured<T>(schema: z.ZodType<T>, _p: string): Promise<T> {
      // LLM returns a "valid" call but it'll also get rejected by upstream.
      return Promise.resolve(schema.parse({ url: "https://x", method: "GET" }));
    },
  };
  try {
    const out = await invokeRankedService(svc(), ADDR, "base", { llm });
    assertEquals(out.status, "error");
    assertEquals(out.adapterPath, "llm");
    assertEquals(out.paid, false);
    assertEquals(cap.error.length >= 1, true);
  } finally {
    cap.restore();
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService does not retry on insufficient_balance", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (_url, _init) => {
    calls++;
    return Promise.resolve(
      jsonResp(402, {
        error: "insufficient_balance",
        error_description: "Have: $0, Need: $0.001",
      }),
    );
  };
  let llmCalls = 0;
  const llm: LlmClient = {
    generateStructured<T>(schema: z.ZodType<T>, _p: string): Promise<T> {
      llmCalls++;
      return Promise.resolve(schema.parse({ url: "https://x", method: "GET" }));
    },
  };
  try {
    const out = await invokeRankedService(svc(), ADDR, "base", { llm });
    assertEquals(out.status, "error");
    assertEquals(out.adapterPath, "pattern");
    assertEquals(out.error?.includes("insufficient_balance"), true);
    assertEquals(calls, 1);
    assertEquals(llmCalls, 0);
  } finally {
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService tries the single POST fallback shape before LLM adapter", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const cap = captureConsole();
  // Capture each body sent — primary and fallback should differ.
  const sentBodies: unknown[] = [];
  let calls = 0;
  globalThis.fetch = (_url, init) => {
    calls++;
    const bodyText = ((init as { body?: string } | undefined)?.body) ?? "";
    try {
      // Inner agnicFetch body is JSON-stringified envelope { url, method, body? }
      const wrapper = JSON.parse(bodyText) as Record<string, unknown>;
      sentBodies.push(wrapper);
    } catch {
      sentBodies.push(null);
    }
    // First call (primary) — return upstream 4xx so we try the fallback shape.
    if (calls === 1) {
      return Promise.resolve(jsonResp(400, {
        error: "upstream_4xx",
        error_description: "wrong key name",
      }));
    }
    // 2nd call (the single { wallet, chain } fallback) succeeds.
    return Promise.resolve(jsonResp(200, { sanctions_match: false }, {
      "X-Agnic-Paid": "true",
      "X-Agnic-Amount": "0.001",
    }));
  };
  // A POST service so the fallback shape applies.
  const postService = svc({
    resource: "https://post.example/v1/check",
    inputInfo: { method: "POST", body: { address: "0xexample", chain: "base" } },
  });
  let llmCalls = 0;
  const llm: LlmClient = {
    generateStructured<T>(schema: z.ZodType<T>, _p: string): Promise<T> {
      llmCalls++;
      return Promise.resolve(schema.parse({ url: "https://x", method: "GET" }));
    },
  };
  try {
    const out = await invokeRankedService(postService, ADDR, "base", { llm });
    assertEquals(out.status, "ok", `expected ok, got ${out.status}: ${out.error}`);
    assertEquals(out.adapterPath, "pattern");
    // 2 calls = primary + 1 fallback shape. LLM never invoked.
    assertEquals(calls, 2);
    assertEquals(llmCalls, 0);
    // At least one warn line about the fallback-shape success.
    assertEquals(
      cap.warn.some((l) => l.includes("succeeded with fallback POST shape")),
      true,
    );
  } finally {
    cap.restore();
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService retries once on Too Many Requests rate limit", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const cap = captureConsole();
  let calls = 0;
  globalThis.fetch = (_url, _init) => {
    calls++;
    if (calls === 1) {
      return Promise.resolve(
        jsonResp(429, {
          error: "rate_limited",
          error_description: "Too many requests from this IP, please try again later.",
        }),
      );
    }
    return Promise.resolve(jsonResp(200, { ok: true }, {
      "X-Agnic-Paid": "true",
      "X-Agnic-Amount": "0.001",
    }));
  };
  // Override the backoff delay so the test doesn't actually sleep 5 seconds.
  // Approach: stub setTimeout to fire immediately for any duration in this test.
  const origSetTimeout = globalThis.setTimeout;
  // deno-lint-ignore no-explicit-any
  globalThis.setTimeout = ((fn: () => void, _ms?: number) => origSetTimeout(fn, 0)) as any;
  const llm = mockLlm({});
  try {
    const out = await invokeRankedService(svc(), ADDR, "base", { llm });
    assertEquals(out.status, "ok", `expected ok, got ${out.status}: ${out.error}`);
    assertEquals(calls, 2);
    assertEquals(
      cap.warn.some((l) => l.includes("rate-limited") && l.includes("backing off")),
      true,
    );
  } finally {
    globalThis.setTimeout = origSetTimeout;
    cap.restore();
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService does NOT retry on insufficient_balance (regression)", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (_url, _init) => {
    calls++;
    return Promise.resolve(
      jsonResp(402, {
        error: "insufficient_balance",
        error_description: "Have: $0, Need: $0.001",
      }),
    );
  };
  let llmCalls = 0;
  const llm: LlmClient = {
    generateStructured<T>(schema: z.ZodType<T>, _p: string): Promise<T> {
      llmCalls++;
      return Promise.resolve(schema.parse({ url: "https://x", method: "GET" }));
    },
  };
  try {
    const out = await invokeRankedService(svc(), ADDR, "base", { llm });
    assertEquals(out.status, "error");
    assertEquals(out.adapterPath, "pattern");
    assertEquals(out.error?.includes("insufficient_balance"), true);
    assertEquals(calls, 1, "hard error should not be retried");
    assertEquals(llmCalls, 0);
  } finally {
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService records amountUsdc and paid from response headers", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  globalThis.fetch = (_url, _init) =>
    Promise.resolve(jsonResp(200, { ok: true }, {
      "X-Agnic-Paid": "true",
      "X-Agnic-Amount": "0.0042",
      "X-Agnic-Network": "base",
      "X-Agnic-Scheme": "exact",
    }));
  const llm = mockLlm({});
  try {
    const out = await invokeRankedService(svc(), ADDR, "base", { llm });
    assertEquals(out.amountUsdc, 0.0042);
    assertEquals(out.paid, true);
    assertEquals(out.network, "base");
  } finally {
    globalThis.fetch = orig;
    teardownAgnic();
  }
});
