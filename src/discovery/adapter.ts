import { z } from "zod";
import type { Chain } from "../agent/types.ts";
import { defaultLlm, type LlmClient } from "../agent/llm.ts";
import type { BazaarInfo, RankedService } from "./types.ts";

const ADDRESS_KEY_PATTERN = /^(address|wallet|addr|account)$/i;

export interface BuiltCall {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
}

export interface BuiltCallSet {
  /** The primary call shape — what to try first. */
  primary: BuiltCall;
  /**
   * Alternative POST body shapes to try if the primary call returns an
   * upstream client error. Each entry is a fully-built call. Empty for
   * GET requests or when the primary is the only reasonable shape.
   */
  fallbacks: BuiltCall[];
}

export class AdapterFailedError extends Error {
  constructor(public readonly reason: string, public readonly service: string) {
    super(`adapter failed for ${service}: ${reason}`);
    this.name = "AdapterFailedError";
  }
}

// --- helpers ---------------------------------------------------------------

function substitutePathParams(
  url: string,
  pathParams: Record<string, unknown>,
  address: string,
): string {
  let out = url;
  for (const [key, exampleVal] of Object.entries(pathParams)) {
    const token = `:${key}`;
    if (out.includes(token)) {
      const replacement = ADDRESS_KEY_PATTERN.test(key)
        ? address
        : String(exampleVal);
      out = out.replaceAll(token, encodeURIComponent(replacement));
    }
  }
  return out;
}

function buildQueryString(
  queryParams: Record<string, unknown>,
  address: string,
): string {
  const params = new URLSearchParams();
  for (const [key, exampleVal] of Object.entries(queryParams)) {
    if (ADDRESS_KEY_PATTERN.test(key)) {
      params.set(key, address);
    } else if (exampleVal !== undefined && exampleVal !== null) {
      // Pass through example values for non-address keys (e.g. asset=ETH).
      // Skip nested schemas — those are spec-of-the-payload, not real values.
      const isPlain = typeof exampleVal === "string" ||
        typeof exampleVal === "number" || typeof exampleVal === "boolean";
      if (isPlain) params.set(key, String(exampleVal));
    }
  }
  return params.toString();
}

function substituteAddressInBody(
  body: unknown,
  address: string,
  chain: Chain,
): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const out: Record<string, unknown> = {};
    let foundAddressKey = false;
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (ADDRESS_KEY_PATTERN.test(k)) {
        out[k] = address;
        foundAddressKey = true;
      } else if (/^chain$/i.test(k)) {
        out[k] = chain;
      } else {
        out[k] = v;
      }
    }
    return foundAddressKey ? out : { ...out, address, chain };
  }
  // No structured body example — default to {address, chain}.
  return { address, chain };
}

// Single alternate POST body shape — the most-common variant. Kept at 1 to
// minimize paid upstream call volume; if it doesn't match, we fall straight
// through to the LLM adapter (cheaper than burning paid retries on a hostile
// catalog).
function alternateBodyShapes(
  address: string,
  chain: Chain,
): Array<Record<string, unknown>> {
  return [
    { wallet: address, chain },
  ];
}

// --- pattern-match adapter -------------------------------------------------

export function buildCallSetFromInfo(
  service: RankedService,
  address: string,
  chain: Chain,
): BuiltCallSet {
  const primary = buildCallFromInfo(service, address, chain);
  // Only POST gets fallback shapes — GET URLs are already built from explicit
  // path/query templates and trying random param permutations is unlikely to
  // help.
  if (primary.method !== "POST") {
    return { primary, fallbacks: [] };
  }
  const primaryBody = primary.body ?? {};
  // De-dupe: skip any shape equivalent to the primary's body.
  const primaryKey = JSON.stringify(primaryBody);
  const fallbacks: BuiltCall[] = [];
  for (const shape of alternateBodyShapes(address, chain)) {
    if (JSON.stringify(shape) === primaryKey) continue;
    fallbacks.push({ url: primary.url, method: "POST", body: shape });
  }
  return { primary, fallbacks };
}

export function buildCallFromInfo(
  service: RankedService,
  address: string,
  chain: Chain,
): BuiltCall {
  if (!service.resource || !service.resource.startsWith("http")) {
    throw new AdapterFailedError("malformed resource URL", service.resource);
  }

  const info: BazaarInfo | undefined = service.inputInfo;

  // No info at all — default to POST {address, chain}.
  if (!info) {
    return { url: service.resource, method: "POST", body: { address, chain } };
  }

  const method = (info.method ?? "POST").toUpperCase() === "GET" ? "GET" : "POST";

  if (method === "GET") {
    let url = service.resource;
    if (info.pathParams && Object.keys(info.pathParams).length > 0) {
      url = substitutePathParams(url, info.pathParams, address);
    }
    if (info.queryParams && Object.keys(info.queryParams).length > 0) {
      const qs = buildQueryString(info.queryParams, address);
      if (qs) url = `${url}${url.includes("?") ? "&" : "?"}${qs}`;
    } else if (!info.pathParams || Object.keys(info.pathParams).length === 0) {
      // GET with no params declared — append ?address= as a best guess.
      url = `${url}?address=${encodeURIComponent(address)}`;
    }
    return { url, method: "GET" };
  }

  // POST: prefer info.body if present, else use queryParams as schema hint.
  let body: unknown;
  if (info.body !== undefined) {
    body = substituteAddressInBody(info.body, address, chain);
  } else if (info.queryParams && Object.keys(info.queryParams).length > 0) {
    body = substituteAddressInBody(info.queryParams, address, chain);
  } else {
    body = { address, chain };
  }

  let url = service.resource;
  if (info.pathParams && Object.keys(info.pathParams).length > 0) {
    url = substitutePathParams(url, info.pathParams, address);
  }

  return { url, method: "POST", body };
}

// --- LLM-fallback adapter --------------------------------------------------

const BuiltCallSchema = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST"]),
  body: z.unknown().optional(),
}).describe("BuiltCall");

const FALLBACK_ADAPTER_MODEL = Deno.env.get("ADAPTER_LLM_MODEL") ??
  "anthropic/claude-haiku-4.5";

export async function buildCallFromInfoViaLlm(
  service: RankedService,
  address: string,
  chain: Chain,
  llm: LlmClient = defaultLlm,
): Promise<BuiltCall> {
  const prompt = `
You are constructing an HTTP call for an x402-paid wallet-analysis service.

Service URL: ${service.resource}
Category: ${service.category}
Description: ${service.description}

The provider declared this input shape (may be partial or missing fields):
${JSON.stringify(service.inputInfo ?? {}, null, 2)}

We need to call this service to analyze the wallet:
  address: ${address}
  chain:   ${chain}

Construct the request:
- Pick "GET" or "POST" based on the declared method (default POST if unclear).
- If GET, build the full URL with the address substituted into any address-like query or path parameter, preserving non-address parameters from the example.
- If POST, build a body that includes the address (and chain if needed) using keys that match the declared schema. If no schema is declared, use { address, chain }.
- Always return a valid http(s) URL.
`.trim();

  try {
    const out = await llm.generateStructured(BuiltCallSchema, prompt, {
      model: FALLBACK_ADAPTER_MODEL,
      toolName: "build_http_call",
      toolDescription:
        "Construct the HTTP call to make to this x402 service. Return " +
        "{ url, method, body? } as the top-level function arguments.",
      toolExample: {
        url: "https://api.example.com/v1/screen?wallet=0xexample",
        method: "GET",
      },
    });
    return out;
  } catch (e) {
    throw new AdapterFailedError(
      `LLM fallback failed: ${(e as Error).message}`,
      service.resource,
    );
  }
}
