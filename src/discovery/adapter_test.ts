import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  AdapterFailedError,
  buildCallFromInfo,
  buildCallFromInfoViaLlm,
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

// --- LLM fallback ---------------------------------------------------------

Deno.test("buildCallFromInfoViaLlm uses LLM to construct args", async () => {
  const fixture = {
    url: "https://svc.example/v1/screen?wallet=" + ADDR,
    method: "GET",
  };
  const captured: { model?: string; promptHasAddress?: boolean } = {};
  const llm: LlmClient = {
    generateStructured<T>(
      schema: z.ZodType<T>,
      prompt: string,
      model?: string,
    ): Promise<T> {
      captured.model = model;
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
  // model is forwarded — should be a non-empty string identifier
  assertEquals(typeof captured.model === "string" && captured.model.length > 0, true);
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
