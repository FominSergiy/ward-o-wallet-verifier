import {
  DiscoveryFetchError,
  WalletUnfundedError,
} from "../discovery/types.ts";
import { SanctionsInvocationError } from "../agent/invoke_all.ts";
import { RegistryUnavailableError } from "../registry/select.ts";

/**
 * A pipeline error classified into a transport-agnostic response shape.
 * `code` is the stable error identifier (the `error` field in JSON bodies, the
 * `code` field in SSE error events). `extra` holds the per-error-type detail
 * fields that JSON routes include in the body; SSE routes emit the leaner
 * code/status/message only and drop `extra`.
 */
export interface MappedRouteError {
  status: 402 | 500 | 502 | 503;
  code: string;
  message: string;
  extra?: Record<string, unknown>;
}

/**
 * Classify a thrown verify/discover pipeline error into a response shape shared
 * by every route. Returns `null` for errors the routes don't own — JSON routes
 * should rethrow (let the app-level onError handle it), stream routes should
 * emit a generic `internal_error` event.
 *
 * This is the single source of truth for error → HTTP-status mapping; previously
 * the same `instanceof` ladder was copy-pasted across all five route handlers.
 */
export function mapRouteError(e: unknown): MappedRouteError | null {
  if (e instanceof WalletUnfundedError) {
    return {
      status: 402,
      code: "wallet_unfunded",
      message: e.message,
      extra: {
        baseAddress: e.baseAddress,
        baseSepoliaAddress: e.baseSepoliaAddress,
      },
    };
  }
  if (e instanceof SanctionsInvocationError) {
    return {
      status: 502,
      code: "sanctions_invocation_failed",
      message: e.message,
    };
  }
  if (e instanceof RegistryUnavailableError) {
    return {
      status: 503,
      code: "registry_unavailable",
      message: e.message,
    };
  }
  if (e instanceof DiscoveryFetchError) {
    return {
      status: 502,
      code: "discovery_upstream_failed",
      message: e.message,
      extra: { status: e.status, url: e.url },
    };
  }
  if (e instanceof Error && e.message.includes("AGNIC_API_KEY")) {
    return { status: 500, code: "missing_config", message: e.message };
  }
  return null;
}

/** Build the JSON error body for a mapped error: `{ error, message, ...extra }`. */
export function jsonErrorBody(m: MappedRouteError): Record<string, unknown> {
  return { error: m.code, message: m.message, ...(m.extra ?? {}) };
}
