import { assertEquals } from "@std/assert";
import { jsonErrorBody, mapRouteError } from "./errors.ts";
import {
  DiscoveryFetchError,
  WalletUnfundedError,
} from "../discovery/types.ts";
import { SanctionsInvocationError } from "../agent/invoke_all.ts";

Deno.test("mapRouteError: WalletUnfundedError → 402 with addresses", () => {
  const m = mapRouteError(new WalletUnfundedError("0xbase", "0xsepolia"));
  assertEquals(m?.status, 402);
  assertEquals(m?.code, "wallet_unfunded");
  assertEquals(m?.extra, {
    baseAddress: "0xbase",
    baseSepoliaAddress: "0xsepolia",
  });
});

Deno.test("mapRouteError: SanctionsInvocationError → 502", () => {
  const m = mapRouteError(new SanctionsInvocationError("upstream 500"));
  assertEquals(m?.status, 502);
  assertEquals(m?.code, "sanctions_invocation_failed");
  assertEquals(m?.extra, undefined);
});

Deno.test("mapRouteError: DiscoveryFetchError → 502 with status+url", () => {
  const m = mapRouteError(
    new DiscoveryFetchError(503, "https://x402.example", "boom"),
  );
  assertEquals(m?.status, 502);
  assertEquals(m?.code, "discovery_upstream_failed");
  assertEquals(m?.extra, { status: 503, url: "https://x402.example" });
});

Deno.test("mapRouteError: missing AGNIC_API_KEY → 500", () => {
  const m = mapRouteError(new Error("AGNIC_API_KEY is required"));
  assertEquals(m?.status, 500);
  assertEquals(m?.code, "missing_config");
});

Deno.test("mapRouteError: unrecognised error → null (caller rethrows)", () => {
  assertEquals(mapRouteError(new Error("something else")), null);
  assertEquals(mapRouteError("not even an error"), null);
});

Deno.test("jsonErrorBody: flattens extra into the body under `error`", () => {
  const body = jsonErrorBody({
    status: 402,
    code: "wallet_unfunded",
    message: "no funds",
    extra: { baseAddress: "0xabc", baseSepoliaAddress: null },
  });
  assertEquals(body, {
    error: "wallet_unfunded",
    message: "no funds",
    baseAddress: "0xabc",
    baseSepoliaAddress: null,
  });
});

Deno.test("jsonErrorBody: omits extra when absent", () => {
  const body = jsonErrorBody({
    status: 500,
    code: "missing_config",
    message: "no key",
  });
  assertEquals(body, { error: "missing_config", message: "no key" });
});
