import { z } from "zod";
import { log } from "../observability/log.ts";
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

// Matches Express-style `:identifier` path placeholders at the start of a path
// segment (after `/` or at path start). Used to catch catalog entries that
// declared a placeholder in the URL but didn't list a matching key in
// `inputInfo.pathParams` — without this guard, the call goes out with the
// literal `:foo` token and the upstream returns an HTML error page (see
// the bad Orbis variant `…wallet-address-risk-api-c6680c/:endpoint`).
const UNSUBSTITUTED_PLACEHOLDER_RE = /(?:^|\/):[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Throws AdapterFailedError if `url`'s path still contains a `:placeholder`
 * token after substitution. Callers are responsible for catching this and
 * surfacing a clear `unsubstituted_path_param` error code so the durable
 * health filter can park the malformed catalog entry.
 */
export function assertNoUnsubstitutedPlaceholders(url: string): void {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Malformed URL — a different validator will catch it.
    return;
  }
  const m = pathname.match(UNSUBSTITUTED_PLACEHOLDER_RE);
  if (m) {
    // m[0] looks like "/:endpoint" or ":endpoint" — strip a leading slash for
    // a cleaner reason field.
    const token = m[0].replace(/^\//, "");
    throw new AdapterFailedError(
      `unsubstituted_path_param: ${token}`,
      url,
    );
  }
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

// --- service-descriptor detection ------------------------------------------

// Info paths that should never be treated as action endpoints when a service's
// root URL returns a descriptor listing its sub-endpoints.
const INFO_PATH_PATTERNS = new Set(["/openapi", "/docs", "/health", "/", ""]);

// Per-category preferences for which sub-endpoint to try first. Keys match the
// Category enum in agent/types.ts. Kept deliberately small — if a service has
// multiple action endpoints and this picks wrong, widen the table; do not
// reach for an LLM picker (the LLM fallback adapter's URL validator is built
// to reject path drift, and adding runtime endpoint selection there is a
// different shape of feature.)
//
// The `labels` category here is broad — it covers both name/entity labelers
// (orbisapi crypto-address-labeler → `/label`) and reputation/risk scorers
// (orbisapi address-reputation-score → `/score`) because the Category enum
// has no separate "risk" or "score" value. Score/risk/reputation tokens are
// listed AFTER the label tokens so a true labeler is preferred when both
// endpoints exist.
const CATEGORY_PREFERRED_TOKENS: Record<string, string[]> = {
  labels: ["label", "tag", "entity", "score", "risk", "reputation"],
  web_sentiment: ["sentiment", "social"],
  sanctions: ["sanctions", "screen", "ofac"],
};

// Returns the endpoints array when `data` looks like a service descriptor
// (object with `endpoints: string[]` and no top-level address-like key).
// The address-key guard prevents false positives on real payloads that happen
// to include an `endpoints` field alongside actual analysis data.
export function isServiceDescriptor(
  data: unknown,
): { endpoints: string[] } | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  const endpoints = obj.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) return null;
  if (!endpoints.every((e) => typeof e === "string")) return null;
  for (const key of Object.keys(obj)) {
    if (ADDRESS_KEY_PATTERN.test(key)) return null;
  }
  return { endpoints: endpoints as string[] };
}

// Picks the best action sub-endpoint from a descriptor's endpoints list.
// Skips info paths (/openapi, /docs, /health, /, ""). When `category` matches
// CATEGORY_PREFERRED_TOKENS, prefers an endpoint whose path contains one of
// the preferred tokens; otherwise returns the first non-info entry. Returns
// null when no non-info endpoint exists.
export function pickActionEndpoint(
  endpoints: string[],
  category?: string,
): string | null {
  const isInfo = (p: string) => INFO_PATH_PATTERNS.has(p.trim().toLowerCase());
  const actions = endpoints.filter((e) => !isInfo(e));
  if (actions.length === 0) return null;
  const preferred = category ? CATEGORY_PREFERRED_TOKENS[category] : undefined;
  if (preferred && preferred.length > 0) {
    for (const tok of preferred) {
      const hit = actions.find((e) => e.toLowerCase().includes(tok));
      if (hit) return hit;
    }
  }
  return actions[0];
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
    assertNoUnsubstitutedPlaceholders(service.resource);
    return { url: service.resource, method: "POST", body: { address, chain } };
  }

  const method = (info.method ?? "POST").toUpperCase() === "GET"
    ? "GET"
    : "POST";

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
    assertNoUnsubstitutedPlaceholders(url);
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
  assertNoUnsubstitutedPlaceholders(url);

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

// Strip the query string from a URL so we can compare just the path portion.
function urlWithoutQuery(u: string): string {
  const q = u.indexOf("?");
  return q >= 0 ? u.slice(0, q) : u;
}

// Apply pathParams substitution to the catalog URL so we can compare it against
// what the LLM returned (the LLM is allowed to substitute path params; it's
// NOT allowed to add/remove/rename path segments).
function substitutedCatalogPath(
  service: RankedService,
  address: string,
): string {
  const base = urlWithoutQuery(service.resource);
  const pathParams = service.inputInfo?.pathParams;
  if (!pathParams || Object.keys(pathParams).length === 0) return base;
  return substitutePathParams(base, pathParams, address);
}

// True iff `candidate` matches `expected` modulo trailing slash differences.
function pathsEquivalent(candidate: string, expected: string): boolean {
  const norm = (s: string) => s.replace(/\/+$/, "");
  return norm(candidate) === norm(expected);
}

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

CRITICAL — URL rules (the catalog URL is authoritative):
- The path portion of \`url\` MUST be exactly "${
    urlWithoutQuery(service.resource)
  }" with any \`:param\` placeholders substituted (use the wallet address for address-like params). DO NOT add, remove, rename, or guess any path segments — no \`/classify\`, \`/predict\`, \`/labels\`, \`/social\`, etc.
- For GET, you MAY append a query string (\`?address=...&chain=...\`).
- For POST, the URL must have no query string and the address goes in the body.
- If the catalog URL already declares the full path, leave it as-is.
`.trim();

  let out: BuiltCall;
  try {
    out = await llm.generateStructured(BuiltCallSchema, prompt, {
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
  } catch (e) {
    throw new AdapterFailedError(
      `LLM fallback failed: ${(e as Error).message}`,
      service.resource,
    );
  }

  // Post-LLM URL validator: enforce path equivalence with the catalog URL.
  // If the LLM invented or rewrote path segments, log it and rewrite to the
  // catalog URL with the LLM's chosen method/body (still valuable signal).
  const llmPath = urlWithoutQuery(out.url);
  const expectedPath = substitutedCatalogPath(service, address);
  if (!pathsEquivalent(llmPath, expectedPath)) {
    log.warn(
      `[adapter-llm] url-changed: rewriting LLM url "${out.url}" → catalog "${service.resource}" (method=${out.method})`,
    );
    if (out.method === "GET") {
      const rewritten = {
        url: `${expectedPath}?address=${encodeURIComponent(address)}&chain=${
          encodeURIComponent(chain)
        }`,
        method: "GET" as const,
      };
      assertNoUnsubstitutedPlaceholders(rewritten.url);
      return rewritten;
    }
    const rewritten = {
      url: expectedPath,
      method: "POST" as const,
      body: out.body ?? { address, chain },
    };
    assertNoUnsubstitutedPlaceholders(rewritten.url);
    return rewritten;
  }

  assertNoUnsubstitutedPlaceholders(out.url);
  return out;
}
