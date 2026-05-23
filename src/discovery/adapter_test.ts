import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  AdapterFailedError,
  buildCallFromInfo,
  buildCallFromInfoViaLlm,
  buildCallSetFromInfo,
} from "./adapter.ts";
import type { LlmClient } from "../agent/llm.ts";
import type { BazaarInfo, RankedService } from "./types.ts";

function svc(args: Partial<RankedService> & { resource?: string }): RankedService {
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
    inputInfo: args.inputInfo,
  };
}

const ADDR = "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2";

Deno.test("buildCallFromInfo handles GET with queryParams.wallet (anchor-x402 shape)", () => {
  const info: BazaarInfo = { method: "GET", queryParams: { wallet: "0xexample" }, type: "http" };
  const built = buildCallFromInfo(
    svc({ resource: "https://api.anchor-x402.com/v1/screen", inputInfo: info }),
    ADDR,
    "base",
  );
  assertEquals(built.method, "GET");
  assertEquals(built.url, `https://api.anchor-x402.com/v1/screen?wallet=${encodeURIComponent(ADDR)}`);
});

Deno.test("buildCallFromInfo handles GET with pathParams.address (aurelianflo shape)", () => {
  const info: BazaarInfo = {
    method: "GET",
    pathParams: { address: "EVM wallet address" },
    queryParams: { asset: "ETH" },
    type: "http",
  };
  const built = buildCallFromInfo(
    svc({
      resource: "https://api.aurelianflo.com/api/ofac-wallet-screen/:address",
      inputInfo: info,
    }),
    ADDR,
    "base",
  );
  assertEquals(built.method, "GET");
  assertEquals(
    built.url,
    `https://api.aurelianflo.com/api/ofac-wallet-screen/${encodeURIComponent(ADDR)}?asset=ETH`,
  );
});

Deno.test("buildCallFromInfo handles POST with body schema (mru-oracle shape)", () => {
  const info: BazaarInfo = {
    method: "POST",
    queryParams: { schema: { address: "string", chain: "string?" }, type: "json" },
    type: "http",
  };
  const built = buildCallFromInfo(
    svc({ resource: "https://mru-oracle.com/compliance/wallet", inputInfo: info }),
    ADDR,
    "base",
  );
  assertEquals(built.method, "POST");
  // queryParams declared a schema, not real values — adapter still produces something useful.
  const body = built.body as Record<string, unknown>;
  assertEquals(body.address, ADDR);
  assertEquals(body.chain, "base");
});

Deno.test("buildCallFromInfo handles POST with explicit body example", () => {
  const info: BazaarInfo = {
    method: "POST",
    body: { wallet: "0xexample", network: "ethereum" },
  };
  const built = buildCallFromInfo(
    svc({ resource: "https://svc.example/v1/check", inputInfo: info }),
    ADDR,
    "base",
  );
  assertEquals(built.method, "POST");
  const body = built.body as Record<string, unknown>;
  assertEquals(body.wallet, ADDR);
  assertEquals(body.network, "ethereum"); // non-address keys preserved
});

Deno.test("buildCallFromInfo defaults to POST {address, chain} when no inputInfo", () => {
  const built = buildCallFromInfo(
    svc({ resource: "https://svc.example/v1/check" }),
    ADDR,
    "base",
  );
  assertEquals(built.method, "POST");
  assertEquals(built.body, { address: ADDR, chain: "base" });
});

Deno.test("buildCallFromInfo preserves non-address queryParams", () => {
  const info: BazaarInfo = {
    method: "GET",
    queryParams: { wallet: "0xex", asset: "ETH", chain_id: 1 },
  };
  const built = buildCallFromInfo(
    svc({ resource: "https://svc.example/v1", inputInfo: info }),
    ADDR,
    "base",
  );
  assertEquals(built.url.includes("wallet="), true);
  assertEquals(built.url.includes("asset=ETH"), true);
  assertEquals(built.url.includes("chain_id=1"), true);
});

Deno.test("buildCallFromInfo throws on malformed resource URL", () => {
  assertThrows(
    () => buildCallFromInfo(svc({ resource: "not-a-url" }), ADDR, "base"),
    AdapterFailedError,
    "malformed",
  );
});

Deno.test("buildCallFromInfo appends address as default param when GET has no params", () => {
  const info: BazaarInfo = { method: "GET" };
  const built = buildCallFromInfo(
    svc({ resource: "https://svc.example/v1/check", inputInfo: info }),
    ADDR,
    "base",
  );
  assertEquals(built.method, "GET");
  assertEquals(built.url, `https://svc.example/v1/check?address=${encodeURIComponent(ADDR)}`);
});

Deno.test("buildCallSetFromInfo produces a single alternate POST shape for POST services", () => {
  const set = buildCallSetFromInfo(
    svc({
      resource: "https://post.example/v1",
      inputInfo: { method: "POST", body: { address: "0xex", chain: "base" } },
    }),
    ADDR,
    "base",
  );
  assertEquals(set.primary.method, "POST");
  // Trimmed to a single { wallet, chain } fallback to minimize paid call volume.
  assertEquals(set.fallbacks.length, 1);
  const primaryKey = JSON.stringify(set.primary.body);
  for (const f of set.fallbacks) {
    assertEquals(f.method, "POST");
    assertEquals(JSON.stringify(f.body) !== primaryKey, true);
    assertEquals(f.url, set.primary.url);
  }
  const bodyJsons = set.fallbacks.map((f) => JSON.stringify(f.body));
  assertEquals(bodyJsons.some((j) => j.includes('"wallet"')), true);
});

Deno.test("buildCallSetFromInfo dedupes when primary body equals the only alternate", () => {
  // Primary body already has { wallet, chain } — the lone alternate should be deduped out.
  const set = buildCallSetFromInfo(
    svc({
      resource: "https://post.example/v1",
      inputInfo: { method: "POST", body: { wallet: "0xex", chain: "base" } },
    }),
    ADDR,
    "base",
  );
  assertEquals(set.primary.method, "POST");
  assertEquals(set.fallbacks.length, 0);
});

Deno.test("buildCallSetFromInfo returns empty fallbacks for GET services", () => {
  const set = buildCallSetFromInfo(
    svc({
      resource: "https://get.example/v1",
      inputInfo: { method: "GET", queryParams: { wallet: "0xex" } },
    }),
    ADDR,
    "base",
  );
  assertEquals(set.primary.method, "GET");
  assertEquals(set.fallbacks, []);
});

// --- LLM fallback ---------------------------------------------------------

Deno.test("buildCallFromInfoViaLlm uses LLM to construct args", async () => {
  const fixture = {
    url: "https://svc.example/v1/screen?wallet=" + ADDR,
    method: "GET",
  };
  const captured: {
    model?: string;
    toolName?: string;
    promptHasAddress?: boolean;
  } = {};
  const llm: LlmClient = {
    generateStructured<T>(
      schema: z.ZodType<T>,
      prompt: string,
      optsOrModel?: { model?: string; toolName?: string } | string,
    ): Promise<T> {
      const opts = typeof optsOrModel === "string"
        ? { model: optsOrModel }
        : optsOrModel ?? {};
      captured.model = opts.model;
      captured.toolName = opts.toolName;
      captured.promptHasAddress = prompt.includes(ADDR);
      return Promise.resolve(schema.parse(fixture));
    },
  };
  const built = await buildCallFromInfoViaLlm(
    svc({ resource: "https://svc.example/v1/screen" }),
    ADDR,
    "base",
    llm,
  );
  assertEquals(built.url, fixture.url);
  assertEquals(built.method, "GET");
  assertEquals(captured.promptHasAddress, true);
  // model is forwarded as opts.model
  assertEquals(typeof captured.model === "string" && captured.model.length > 0, true);
  // toolName is forwarded
  assertEquals(captured.toolName, "build_http_call");
});

Deno.test("buildCallFromInfoViaLlm throws AdapterFailedError when LLM throws", async () => {
  const llm: LlmClient = {
    generateStructured: () => Promise.reject(new Error("LLM down")),
  };
  await assertRejects(
    () => buildCallFromInfoViaLlm(
      svc({ resource: "https://svc.example/v1" }),
      ADDR,
      "base",
      llm,
    ),
    AdapterFailedError,
    "LLM fallback failed",
  );
});

Deno.test("buildCallFromInfoViaLlm rewrites URL when LLM invents path segments", async () => {
  const mangled = {
    url: "https://svc.example/v1/screen/classify",
    method: "POST",
    body: { wallet: ADDR },
  };
  const llm: LlmClient = {
    generateStructured: <T>(schema: z.ZodType<T>) =>
      Promise.resolve(schema.parse(mangled)),
  };
  const built = await buildCallFromInfoViaLlm(
    svc({ resource: "https://svc.example/v1/screen" }),
    ADDR,
    "base",
    llm,
  );
  // URL is reset to the catalog path; LLM's body shape is preserved.
  assertEquals(built.url, "https://svc.example/v1/screen");
  assertEquals(built.method, "POST");
  assertEquals(built.body, { wallet: ADDR });
});

Deno.test("buildCallFromInfoViaLlm accepts URL with substituted path params", async () => {
  const fixture = {
    url: `https://svc.example/v1/screen/${encodeURIComponent(ADDR)}`,
    method: "GET",
  };
  const llm: LlmClient = {
    generateStructured: <T>(schema: z.ZodType<T>) =>
      Promise.resolve(schema.parse(fixture)),
  };
  const built = await buildCallFromInfoViaLlm(
    svc({
      resource: "https://svc.example/v1/screen/:address",
      inputInfo: {
        method: "GET",
        pathParams: { address: "0xexample" },
      },
    }),
    ADDR,
    "base",
    llm,
  );
  // Path-param substitution is the LLM's job and is accepted as-is.
  assertEquals(built.url, fixture.url);
  assertEquals(built.method, "GET");
});

Deno.test("buildCallFromInfoViaLlm throws when LLM returns malformed call", async () => {
  const llm: LlmClient = {
    generateStructured: () => Promise.reject(new Error("schema parse")),
  };
  await assertRejects(
    () =>
      buildCallFromInfoViaLlm(
        svc({ resource: "https://svc.example/v1" }),
        ADDR,
        "base",
        llm,
      ),
    AdapterFailedError,
  );
});
