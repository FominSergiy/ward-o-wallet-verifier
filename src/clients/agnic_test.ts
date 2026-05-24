import { assertEquals, assertRejects } from "@std/assert";
import { agnicFetch, AgnicFetchError } from "./agnic.ts";

function mockFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): typeof globalThis.fetch {
  return (_url, _init) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      }),
    );
}

Deno.test("agnicFetch: paid=true response parses amountUsd from header", async () => {
  Deno.env.set("AGNIC_API_KEY", "test-key");
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch(200, { result: "ok" }, {
    "X-Agnic-Paid": "true",
    "X-Agnic-Amount": "0.25",
    "X-Agnic-Network": "base-sepolia",
    "X-Agnic-Scheme": "exact",
  });
  try {
    const r = await agnicFetch("https://example.com/paid");
    assertEquals(r.paid, true);
    assertEquals(r.amountUsd, 0.25);
    assertEquals(r.network, "base-sepolia");
    assertEquals(r.scheme, "exact");
    assertEquals((r.data as { result: string }).result, "ok");
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("agnicFetch: paid=false response has amountUsd=0", async () => {
  Deno.env.set("AGNIC_API_KEY", "test-key");
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch(200, { result: "free" }, { "X-Agnic-Paid": "false" });
  try {
    const r = await agnicFetch("https://example.com/free");
    assertEquals(r.paid, false);
    assertEquals(r.amountUsd, 0);
    assertEquals(r.network, null);
    assertEquals(r.scheme, null);
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("agnicFetch: maxValueUsd converts to atomic units", async () => {
  Deno.env.set("AGNIC_API_KEY", "test-key");
  const orig = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (url, _init) => {
    capturedUrl = url.toString();
    return Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "X-Agnic-Paid": "false" },
      }),
    );
  };
  try {
    await agnicFetch("https://example.com", { maxValueUsd: 0.001 });
    // $0.001 * 1_000_000 = 1000 atomic units
    assertEquals(capturedUrl.includes("maxValue=1000"), true);
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("agnicFetch: insufficient_balance throws AgnicFetchError", async () => {
  Deno.env.set("AGNIC_API_KEY", "test-key");
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch(402, {
    error: "insufficient_balance",
    error_description: "Not enough USDC balance",
  });
  try {
    await assertRejects(
      () => agnicFetch("https://example.com"),
      AgnicFetchError,
      "insufficient_balance",
    );
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("agnicFetch: payment_exceeds_max throws AgnicFetchError", async () => {
  Deno.env.set("AGNIC_API_KEY", "test-key");
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch(400, {
    error: "payment_exceeds_max",
    error_description: "Required amount exceeds maxValue",
  });
  try {
    await assertRejects(
      () => agnicFetch("https://example.com"),
      AgnicFetchError,
      "payment_exceeds_max",
    );
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("agnicFetch: 'Not found' upstream error is normalized to not_found code", async () => {
  Deno.env.set("AGNIC_API_KEY", "test-key");
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch(404, {
    error: "Not found",
    error_description: "Not Found",
  });
  try {
    const err = await assertRejects(
      () => agnicFetch("https://example.com/missing"),
      AgnicFetchError,
    );
    assertEquals(err.code, "not_found");
    // Message preserves the raw upstream code for human-readable logs.
    assertEquals(err.message.includes("[Not found]"), true);
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("agnicFetch: HTML response throws AgnicFetchError with non_json_response code", async () => {
  Deno.env.set("AGNIC_API_KEY", "test-key");
  const orig = globalThis.fetch;
  globalThis.fetch = (_url, _init) =>
    Promise.resolve(
      new Response(
        "<html><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>",
        { status: 502, headers: { "Content-Type": "text/html" } },
      ),
    );
  try {
    const err = await assertRejects(
      () => agnicFetch("https://example.com/html"),
      AgnicFetchError,
    );
    assertEquals(err.code, "non_json_response");
    assertEquals(err.message.includes("HTTP 502"), true);
    // Body preview is included so we know what the upstream actually sent.
    assertEquals(err.message.includes("502 Bad Gateway"), true);
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("agnicFetch: empty body throws non_json_response (no spurious SyntaxError)", async () => {
  Deno.env.set("AGNIC_API_KEY", "test-key");
  const orig = globalThis.fetch;
  globalThis.fetch = (_url, _init) =>
    Promise.resolve(new Response("", { status: 500 }));
  try {
    const err = await assertRejects(
      () => agnicFetch("https://example.com/empty"),
      AgnicFetchError,
    );
    assertEquals(err.code, "non_json_response");
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("agnicFetch: per-call timeout fires and throws AgnicFetchError with code=timeout", async () => {
  Deno.env.set("AGNIC_API_KEY", "test-key");
  const orig = globalThis.fetch;
  // Real fetch honors the AbortSignal we pass; simulate a hung upstream by
  // never resolving until the signal aborts, then reject with the abort reason
  // (matches native fetch behavior).
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const sig = (init as RequestInit | undefined)?.signal ?? null;
      if (!sig) return;
      sig.addEventListener("abort", () => reject(sig.reason));
    });
  try {
    const err = await assertRejects(
      () => agnicFetch("https://example.com/hangs", { timeoutMs: 50 }),
      AgnicFetchError,
    );
    assertEquals(err.code, "timeout");
    assertEquals(err.message.includes("50ms"), true);
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("agnicFetch: caller-supplied signal aborting first propagates original error (not timeout)", async () => {
  Deno.env.set("AGNIC_API_KEY", "test-key");
  const orig = globalThis.fetch;
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const sig = (init as RequestInit | undefined)?.signal ?? null;
      if (!sig) return;
      sig.addEventListener("abort", () => reject(sig.reason));
    });
  try {
    const ac = new AbortController();
    const reason = new Error("caller cancelled");
    setTimeout(() => ac.abort(reason), 20);
    // timeoutMs is far longer than the caller cancellation, so the caller
    // signal wins. We expect the original Error, not an AgnicFetchError(timeout).
    await assertRejects(
      () =>
        agnicFetch("https://example.com/hangs", {
          timeoutMs: 10_000,
          signal: ac.signal,
        }),
      Error,
      "caller cancelled",
    );
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("AGNIC_API_KEY");
  }
});

Deno.test("agnicFetch: missing AGNIC_API_KEY throws before making any fetch call", async () => {
  Deno.env.delete("AGNIC_API_KEY");
  let fetchCalled = false;
  const orig = globalThis.fetch;
  globalThis.fetch = (_url, _init) => {
    fetchCalled = true;
    return Promise.resolve(new Response("", { status: 200 }));
  };
  try {
    await assertRejects(
      () => agnicFetch("https://example.com"),
      Error,
      "AGNIC_API_KEY not set",
    );
    assertEquals(fetchCalled, false);
  } finally {
    globalThis.fetch = orig;
  }
});
