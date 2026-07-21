import { assertEquals } from "@std/assert";
import { z } from "zod";
import {
  appendSubPath,
  invokeRankedService,
  isPayable,
  maxValueForPrice,
} from "./invoke_service.ts";
import { type LlmClient, mockLlm } from "./llm.ts";
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
    inputInfo: args.inputInfo ??
      { method: "GET", queryParams: { wallet: "0xexample" } },
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

function jsonResp(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
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
        jsonResp(400, {
          error: "upstream_4xx",
          error_description: "missing wallet param",
        }),
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
        schema.parse({
          url: "https://svc.example/v1/screen?wallet=" + ADDR,
          method: "GET",
        }),
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
      jsonResp(400, {
        error: "upstream_4xx",
        error_description: "bad request",
      }),
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
    inputInfo: {
      method: "POST",
      body: { address: "0xexample", chain: "base" },
    },
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
    assertEquals(
      out.status,
      "ok",
      `expected ok, got ${out.status}: ${out.error}`,
    );
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
          error_description:
            "Too many requests from this IP, please try again later.",
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
  globalThis.setTimeout =
    ((fn: () => void, _ms?: number) => origSetTimeout(fn, 0)) as any;
  const llm = mockLlm({});
  try {
    const out = await invokeRankedService(svc(), ADDR, "base", { llm });
    assertEquals(
      out.status,
      "ok",
      `expected ok, got ${out.status}: ${out.error}`,
    );
    assertEquals(calls, 2);
    assertEquals(
      cap.warn.some((l) =>
        l.includes("rate-limited") && l.includes("backing off")
      ),
      true,
    );
  } finally {
    globalThis.setTimeout = origSetTimeout;
    cap.restore();
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService surfaces errorCode rate_limited when still rate-limited after retry", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const cap = captureConsole();
  // Always 429 — both the initial attempt and the post-backoff retry. The
  // outcome must classify as "rate_limited", NOT a misleading "timeout".
  globalThis.fetch = (_url, _init) =>
    Promise.resolve(
      jsonResp(429, {
        error: "rate_limited",
        error_description: "Too many requests from this IP.",
      }),
    );
  const origSetTimeout = globalThis.setTimeout;
  // deno-lint-ignore no-explicit-any
  globalThis.setTimeout =
    ((fn: () => void, _ms?: number) => origSetTimeout(fn, 0)) as any;
  const llm = mockLlm({});
  try {
    const out = await invokeRankedService(svc(), ADDR, "base", { llm });
    assertEquals(out.status, "error");
    assertEquals(out.errorCode, "rate_limited");
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

Deno.test("invokeRankedService surfaces adapter_build_failed on pattern-build throw", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (_url, _init) => {
    fetchCalls++;
    return Promise.resolve(jsonResp(200, { ok: true }));
  };
  const llm = mockLlm({});
  // Malformed resource URL — buildCallFromInfo throws AdapterFailedError
  // before any fetch is issued.
  const bad = svc({ resource: "not-a-url" });
  try {
    const out = await invokeRankedService(bad, ADDR, "base", { llm });
    assertEquals(out.status, "error");
    assertEquals(out.adapterPath, "pattern");
    assertEquals(out.errorCode, "adapter_build_failed");
    assertEquals(fetchCalls, 0);
  } finally {
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService surfaces adapter_llm_build_failed when LLM throws", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const cap = captureConsole();
  // Pattern call returns an upstream_4xx so we fall through to the LLM layer.
  globalThis.fetch = (_url, _init) =>
    Promise.resolve(
      jsonResp(400, {
        error: "upstream_4xx",
        error_description: "wrong shape",
      }),
    );
  const llm: LlmClient = {
    generateStructured<T>(_schema: z.ZodType<T>, _p: string): Promise<T> {
      return Promise.reject(new Error("simulated llm outage"));
    },
  };
  try {
    const out = await invokeRankedService(svc(), ADDR, "base", { llm });
    assertEquals(out.status, "error");
    assertEquals(out.adapterPath, "llm");
    assertEquals(out.errorCode, "adapter_llm_build_failed");
  } finally {
    cap.restore();
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService surfaces adapter_call_failed on non-Agnic exec throw in LLM layer", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const cap = captureConsole();
  let calls = 0;
  globalThis.fetch = (_url, _init) => {
    calls++;
    if (calls === 1) {
      // Pattern primary — upstream_4xx forces LLM fallback.
      return Promise.resolve(
        jsonResp(400, {
          error: "upstream_4xx",
          error_description: "bad shape",
        }),
      );
    }
    // LLM call: simulate a transport-level failure (non-AgnicFetchError).
    return Promise.reject(new TypeError("network down"));
  };
  const llm: LlmClient = {
    generateStructured<T>(schema: z.ZodType<T>, _p: string): Promise<T> {
      return Promise.resolve(
        schema.parse({
          url: "https://svc.example/v1/screen?wallet=" + ADDR,
          method: "GET",
        }),
      );
    },
  };
  try {
    const out = await invokeRankedService(svc(), ADDR, "base", { llm });
    assertEquals(out.status, "error");
    assertEquals(out.adapterPath, "llm");
    assertEquals(out.errorCode, "adapter_call_failed");
    assertEquals(calls, 2);
  } finally {
    cap.restore();
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService: payment-cap error is hard (no LLM fallback)", async () => {
  // Regression for the de-x402/price-drift case: agnicFetch normalizes
  // "Payment exceeds maximum allowed value" → payment_exceeds_maximum_allowed_value.
  // That's a payment-budget rejection, not an input-shape problem, so it must
  // NOT waste an LLM fallback + retry. A GET service (no POST-shape fallback)
  // isolates the LLM-fallback decision.
  setupAgnic();
  const orig = globalThis.fetch;
  const cap = captureConsole();
  let fetchCalls = 0;
  globalThis.fetch = (_url, _init) => {
    fetchCalls++;
    return Promise.resolve(
      jsonResp(402, {
        error: "Payment exceeds maximum allowed value",
        error_description: "Payment Required",
      }),
    );
  };
  let llmCalls = 0;
  const llm: LlmClient = {
    generateStructured<T>(schema: z.ZodType<T>, _p: string): Promise<T> {
      llmCalls++;
      return Promise.resolve(
        schema.parse({ url: "https://svc.example/x", method: "GET" }),
      );
    },
  };
  try {
    const out = await invokeRankedService(svc(), ADDR, "base", { llm });
    assertEquals(out.status, "error");
    // The cap error must short-circuit: no LLM fallback, single network call.
    assertEquals(llmCalls, 0, "cap error must not trigger LLM fallback");
    assertEquals(fetchCalls, 1, "only the pattern attempt should hit network");
    assertEquals(out.adapterPath, "pattern");
    assertEquals(out.errorCode, "payment_exceeds_maximum_allowed_value");
  } finally {
    cap.restore();
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService skips pattern adapter when FORCE_LLM_ADAPTER=true", async () => {
  setupAgnic();
  Deno.env.set("FORCE_LLM_ADAPTER", "true");
  const orig = globalThis.fetch;
  const cap = captureConsole();
  let fetchCalls = 0;
  // agnicFetch passes the target as ?url= on its own request — inspect that
  // to confirm the address was substituted (LLM path) rather than the bare
  // catalog URL (which would mean pattern ran).
  const seenTargets: string[] = [];
  globalThis.fetch = (url, _init) => {
    fetchCalls++;
    const u = new URL(url.toString());
    const target = u.searchParams.get("url");
    if (target) seenTargets.push(target);
    return Promise.resolve(jsonResp(200, { ok: true }, {
      "X-Agnic-Paid": "true",
      "X-Agnic-Amount": "0.001",
    }));
  };
  let llmCalls = 0;
  const llm: LlmClient = {
    generateStructured<T>(schema: z.ZodType<T>, _p: string): Promise<T> {
      llmCalls++;
      return Promise.resolve(
        schema.parse({
          url: "https://svc.example/v1/screen?wallet=" + ADDR,
          method: "GET",
        }),
      );
    },
  };
  try {
    const out = await invokeRankedService(svc(), ADDR, "base", { llm });
    assertEquals(out.status, "fallback_ok");
    assertEquals(out.adapterPath, "llm");
    assertEquals(llmCalls, 1, "LLM must be invoked exactly once");
    assertEquals(
      fetchCalls,
      1,
      "only the LLM-built call should hit the network",
    );
    assertEquals(
      seenTargets[0].includes("?wallet=") ||
        seenTargets[0].includes("?address="),
      true,
      `first fetch target should be the LLM-built URL with substituted address, got: ${
        seenTargets[0]
      }`,
    );
    assertEquals(
      cap.warn.some((l) => l.includes("FORCE_LLM_ADAPTER=true")),
      true,
    );
  } finally {
    cap.restore();
    Deno.env.delete("FORCE_LLM_ADAPTER");
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

// --- service-descriptor retry --------------------------------------------

// Extracts the target URL that agnicFetch wrapped into its outgoing fetch
// (sent as `?url=<target>` on the wrapper request). Mirrors the trick the
// FORCE_LLM_ADAPTER test uses.
function targetUrlOf(fetchInput: string | URL | Request): string | null {
  const u = new URL(fetchInput.toString());
  return u.searchParams.get("url");
}

const ORBIS_LABELS_URL =
  "https://orbisapi.com/proxy/crypto-address-labeler-api-79be80";

Deno.test("invokeRankedService retries against sub-path on descriptor response", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const cap = captureConsole();
  const seenTargets: string[] = [];
  let calls = 0;
  globalThis.fetch = (url, _init) => {
    calls++;
    const t = targetUrlOf(url);
    if (t) seenTargets.push(t);
    if (calls === 1) {
      // Descriptor response — base URL returns endpoints list.
      return Promise.resolve(jsonResp(200, {
        name: "Crypto Address Labeler API",
        endpoints: ["/label", "/openapi"],
        docs: "/openapi",
      }, {
        "X-Agnic-Paid": "true",
        "X-Agnic-Amount": "0.005",
      }));
    }
    // Sub-path retry — real address payload.
    return Promise.resolve(jsonResp(200, {
      address: ADDR,
      known_label: "Vitalik",
      entity_type: "EOA",
      risk_level: "low",
      is_known: true,
    }, {
      "X-Agnic-Paid": "true",
      "X-Agnic-Amount": "0.005",
    }));
  };
  const llm = mockLlm({});
  try {
    const out = await invokeRankedService(
      svc({
        category: "labels",
        resource: ORBIS_LABELS_URL,
        inputInfo: { method: "GET" },
      }),
      ADDR,
      "base",
      { llm },
    );
    assertEquals(
      out.status,
      "ok",
      `expected ok, got ${out.status}: ${out.error}`,
    );
    assertEquals(out.adapterPath, "pattern+subpath");
    assertEquals((out.data as Record<string, unknown>).known_label, "Vitalik");
    assertEquals(calls, 2);
    // First call hits the base URL; second includes the /label sub-path.
    assertEquals(
      seenTargets[0],
      `${ORBIS_LABELS_URL}?address=${encodeURIComponent(ADDR)}`,
    );
    assertEquals(
      seenTargets[1].startsWith(`${ORBIS_LABELS_URL}/label`),
      true,
      `expected second call to hit /label, got: ${seenTargets[1]}`,
    );
    assertEquals(
      cap.warn.some((l) =>
        l.includes("returned descriptor") && l.includes("/label")
      ),
      true,
    );
  } finally {
    cap.restore();
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService returns descriptor_only_response when only info endpoints present", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const cap = captureConsole();
  let calls = 0;
  globalThis.fetch = (_url, _init) => {
    calls++;
    return Promise.resolve(jsonResp(200, {
      name: "Bare Descriptor Service",
      endpoints: ["/openapi", "/docs"],
    }, {
      "X-Agnic-Paid": "true",
      "X-Agnic-Amount": "0.005",
    }));
  };
  const llm = mockLlm({});
  try {
    const out = await invokeRankedService(
      svc({
        category: "labels",
        resource: "https://x.example/svc",
        inputInfo: { method: "GET" },
      }),
      ADDR,
      "base",
      { llm },
    );
    assertEquals(out.status, "error");
    assertEquals(out.errorCode, "descriptor_only_response");
    assertEquals(out.adapterPath, "pattern+subpath");
    assertEquals(
      calls,
      1,
      "no retry should be attempted when no action endpoint exists",
    );
    assertEquals(
      cap.warn.some((l) =>
        l.includes("no action endpoint") && l.includes("/openapi")
      ),
      true,
      "warn log should include the endpoints array verbatim",
    );
  } finally {
    cap.restore();
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService surfaces descriptor_only_response when retry also returns descriptor", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const cap = captureConsole();
  let calls = 0;
  globalThis.fetch = (_url, _init) => {
    calls++;
    return Promise.resolve(jsonResp(200, {
      name: "Recursive Descriptor",
      endpoints: ["/label", "/openapi"],
    }, {
      "X-Agnic-Paid": "true",
      "X-Agnic-Amount": "0.005",
    }));
  };
  const llm = mockLlm({});
  try {
    const out = await invokeRankedService(
      svc({
        category: "labels",
        resource: "https://x.example/svc",
        inputInfo: { method: "GET" },
      }),
      ADDR,
      "base",
      { llm },
    );
    assertEquals(out.status, "error");
    assertEquals(out.errorCode, "descriptor_only_response");
    assertEquals(out.adapterPath, "pattern+subpath");
    assertEquals(calls, 2, "exactly one retry should be attempted");
    assertEquals(
      cap.warn.some((l) => l.includes("also returned descriptor")),
      true,
    );
  } finally {
    cap.restore();
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService propagates sub-path retry failure code", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const cap = captureConsole();
  let calls = 0;
  globalThis.fetch = (_url, _init) => {
    calls++;
    if (calls === 1) {
      return Promise.resolve(jsonResp(200, {
        endpoints: ["/label", "/openapi"],
      }, {
        "X-Agnic-Paid": "true",
        "X-Agnic-Amount": "0.005",
      }));
    }
    return Promise.resolve(
      jsonResp(400, {
        error: "upstream_4xx",
        error_description: "subpath rejected",
      }),
    );
  };
  const llm = mockLlm({});
  try {
    const out = await invokeRankedService(
      svc({
        category: "labels",
        resource: "https://x.example/svc",
        inputInfo: { method: "GET" },
      }),
      ADDR,
      "base",
      { llm },
    );
    assertEquals(out.status, "error");
    assertEquals(out.adapterPath, "pattern+subpath");
    assertEquals(out.errorCode, "upstream_4xx");
    assertEquals(calls, 2);
    assertEquals(
      cap.warn.some((l) =>
        l.includes("sub-path retry") && l.includes("failed")
      ),
      true,
    );
  } finally {
    cap.restore();
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService descriptor retry preserves POST body and appends sub-path", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const cap = captureConsole();
  const seenTargets: string[] = [];
  const seenBodies: unknown[] = [];
  let calls = 0;
  globalThis.fetch = (url, init) => {
    calls++;
    const t = targetUrlOf(url);
    if (t) seenTargets.push(t);
    // The agnicFetch wrapper request body is JSON-stringified { url, method, body? }.
    const wrapperBody = ((init as { body?: string } | undefined)?.body) ?? "";
    try {
      const wrapper = JSON.parse(wrapperBody) as { body?: unknown };
      seenBodies.push(wrapper.body ?? null);
    } catch {
      seenBodies.push(null);
    }
    if (calls === 1) {
      return Promise.resolve(jsonResp(200, {
        endpoints: ["/label", "/openapi"],
      }, {
        "X-Agnic-Paid": "true",
        "X-Agnic-Amount": "0.005",
      }));
    }
    return Promise.resolve(jsonResp(200, {
      address: ADDR,
      known_label: "Some Entity",
    }, {
      "X-Agnic-Paid": "true",
      "X-Agnic-Amount": "0.005",
    }));
  };
  const llm = mockLlm({});
  try {
    const out = await invokeRankedService(
      svc({
        category: "labels",
        resource: "https://post.example/v1",
        inputInfo: {
          method: "POST",
          body: { address: "0xexample", chain: "base" },
        },
      }),
      ADDR,
      "base",
      { llm },
    );
    assertEquals(out.status, "ok");
    assertEquals(out.adapterPath, "pattern+subpath");
    assertEquals(calls, 2);
    // Retry URL has /label appended; body matches primary.
    assertEquals(seenTargets[1], "https://post.example/v1/label");
    assertEquals(
      JSON.stringify(seenBodies[1]),
      JSON.stringify(seenBodies[0]),
      "retry body should match primary POST body",
    );
  } finally {
    cap.restore();
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

// --- maxValue headroom (W0.11) -------------------------------------------

function withBufferEnv<T>(value: string | null, fn: () => T): T {
  const prev = Deno.env.get("INVOKE_MAXVALUE_BUFFER");
  if (value === null) Deno.env.delete("INVOKE_MAXVALUE_BUFFER");
  else Deno.env.set("INVOKE_MAXVALUE_BUFFER", value);
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete("INVOKE_MAXVALUE_BUFFER");
    else Deno.env.set("INVOKE_MAXVALUE_BUFFER", prev);
  }
}

Deno.test("maxValueForPrice: applies default 1.5× buffer below the ceiling", () => {
  withBufferEnv(null, () => {
    // 0.001 × 1.5 = 0.0015, well under the $0.10 ceiling.
    assertEquals(maxValueForPrice(0.001), 0.0015);
  });
});

Deno.test("maxValueForPrice: clamps to the $0.10 ceiling above it", () => {
  withBufferEnv(null, () => {
    // 0.08 × 1.5 = 0.12 → clamped to the 0.10 ceiling.
    assertEquals(maxValueForPrice(0.08), 0.1);
    // Exactly at the ceiling input also stays bounded.
    assertEquals(maxValueForPrice(0.1), 0.1);
  });
});

Deno.test("maxValueForPrice: honors INVOKE_MAXVALUE_BUFFER override", () => {
  withBufferEnv("2", () => {
    assertEquals(maxValueForPrice(0.001), 0.002);
  });
  // Non-numeric / empty falls back to the 1.5 default.
  withBufferEnv("", () => assertEquals(maxValueForPrice(0.001), 0.0015));
  withBufferEnv(
    "not-a-number",
    () => assertEquals(maxValueForPrice(0.001), 0.0015),
  );
});

Deno.test("isPayable: true at/below the cap, false above it", () => {
  withBufferEnv(null, () => {
    assertEquals(isPayable(0.005), true);
    assertEquals(isPayable(0.1), true); // boundary — exactly at the ceiling
    assertEquals(isPayable(0.15), false);
    assertEquals(isPayable(1.5), false);
  });
});

// Reads the maxValue micro-USDC the agnic client put on its outgoing request
// (agnicFetch encodes it as ?maxValue=<ceil(usd*1e6)>).
function maxValueMicroOf(fetchInput: string | URL | Request): string | null {
  return new URL(fetchInput.toString()).searchParams.get("maxValue");
}

Deno.test("invokeRankedService sends min(price×buffer, ceiling) as maxValue — below ceiling", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const seen: Array<string | null> = [];
  globalThis.fetch = (url, _init) => {
    seen.push(maxValueMicroOf(url));
    return Promise.resolve(jsonResp(200, { ok: true }, {
      "X-Agnic-Paid": "true",
      "X-Agnic-Amount": "0.001",
    }));
  };
  try {
    await withBufferEnv(null, async () => {
      await invokeRankedService(svc({ priceUsdc: 0.001 }), ADDR, "base", {
        llm: mockLlm({}),
      });
    });
    // 0.001 × 1.5 = 0.0015 USDC → ceil(0.0015 × 1e6) = 1500 micro-USDC.
    assertEquals(seen[0], "1500");
  } finally {
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("invokeRankedService clamps maxValue to the ceiling — above ceiling", async () => {
  setupAgnic();
  const orig = globalThis.fetch;
  const seen: Array<string | null> = [];
  globalThis.fetch = (url, _init) => {
    seen.push(maxValueMicroOf(url));
    return Promise.resolve(jsonResp(200, { ok: true }, {
      "X-Agnic-Paid": "true",
      "X-Agnic-Amount": "0.08",
    }));
  };
  try {
    await withBufferEnv(null, async () => {
      await invokeRankedService(svc({ priceUsdc: 0.08 }), ADDR, "base", {
        llm: mockLlm({}),
      });
    });
    // 0.08 × 1.5 = 0.12 → clamped to 0.10 USDC → 100000 micro-USDC.
    assertEquals(seen[0], "100000");
  } finally {
    globalThis.fetch = orig;
    teardownAgnic();
  }
});

Deno.test("appendSubPath preserves query string on GET URLs", () => {
  assertEquals(
    appendSubPath("https://x.example/y?a=1&b=2", "/label"),
    "https://x.example/y/label?a=1&b=2",
  );
});

Deno.test("appendSubPath collapses duplicate slashes at the join", () => {
  assertEquals(
    appendSubPath("https://x.example/y/", "/label"),
    "https://x.example/y/label",
  );
  assertEquals(
    appendSubPath("https://x.example/y", "label"),
    "https://x.example/y/label",
  );
  assertEquals(
    appendSubPath("https://x.example/y//", "//label"),
    "https://x.example/y/label",
  );
});
