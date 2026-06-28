// Immediate, fire-and-forget registry block for structurally-dead endpoints.
//
// The scorer (registry/score.ts) demotes services on a trailing-window batch
// run, so between vetter runs a structurally-dead service keeps winning the
// primary slot and burns 6–9s per request discovering it's still dead. When the
// invocation path sees an error code that signals the endpoint can NEVER serve
// data (not payable via x402, 404, malformed catalog row), we block it right
// away so the very next request's getActiveServices() excludes it (the existing
// `WHERE status != 'blocked'` filter). blocked is only lifted by an operator /
// re-vet, which is correct for genuine structural deadness.
//
// Deliberately NOT included here: transient codes (timeout, rate_limited,
// upstream_5xx, non_json_response — which can be a 503 HTML page) and payer-side
// config codes (payment_exceeds_*, insufficient_balance) — those must not
// one-strike a service. Payer-side codes are handled by the scorer's exclusion.

import { getDb } from "../db/client.ts";
import { ServiceStatus } from "../db/enums.ts";
import { log } from "../observability/log.ts";

// Normalized agnicFetch error codes (see clients/agnic.ts normalization:
// rawCode.toLowerCase().replace(/[\s-]+/g, "_")) that mean the endpoint is
// structurally dead — safe to block on a single strike.
export const DOMAIN_DEAD_CODES: ReadonlySet<string> = new Set([
  "target_api_is_not_x402_enabled",
  "not_found",
  "upstream_404",
  "unsubstituted_path_param",
  "descriptor_only_response",
]);

export function isDomainDeadCode(code: string | undefined): boolean {
  if (!code) return false;
  return DOMAIN_DEAD_CODES.has(code);
}

/**
 * Fire-and-forget: mark a service blocked when it returns a structural-deadness
 * error code. No-op when the code isn't a dead-code or when DATABASE_URL is
 * unset (getDb() is the no-op client → resolves empty). Never throws into the
 * caller — a failed write must not slow or break the verify pipeline.
 */
export function blockDeadServiceIfStructural(
  resource: string,
  code: string | undefined,
): void {
  if (!isDomainDeadCode(code)) return;
  const db = getDb();
  Promise.resolve(
    db`
      UPDATE service_registry
      SET status = ${ServiceStatus.BLOCKED}, updated_at = now()
      WHERE resource = ${resource} AND status <> ${ServiceStatus.BLOCKED}
    `,
  )
    .then(() => {
      log.warn(
        `[registry] persist-block: ${resource} blocked on structural error code=${code}`,
      );
    })
    .catch((err: unknown) => {
      log.error(
        "[registry] persist-block failed:",
        (err as Error)?.message ?? err,
      );
    });
}
