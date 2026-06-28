// Env-configurable dead-host denylist.
//
// Some upstream providers turn off x402 wholesale: orbisapi.com de-x402'd its
// entire /proxy/* catalog, so every endpoint there now returns
// `target_api_is_not_x402_enabled`. Blocking the DB rows alone isn't enough —
// the vetter's discovery would re-seed them on the next run — so denied hosts
// are filtered at BOTH discovery-insert time (src/vetter/run.ts) and
// registry-selection time (src/registry/select.ts).
//
// DISCOVERY_HOST_DENYLIST is a comma-separated list of host substrings; the
// default is "orbisapi.com". It's env-overridable so a host can be re-enabled
// without a code change if the provider ever turns x402 back on. Matching is a
// case-insensitive substring test, mirroring the one-time prod sweep
// (`WHERE resource ILIKE '%orbisapi.com%'`).

const DEFAULT_DENYLIST = "orbisapi.com";

/** Parse DISCOVERY_HOST_DENYLIST (or the default) into normalized host tokens. */
export function getDeniedHosts(): string[] {
  const raw = Deno.env.get("DISCOVERY_HOST_DENYLIST") ?? DEFAULT_DENYLIST;
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * True when `resource` (a URL or resource string) matches any denied host.
 * Pass `deniedHosts` to reuse a single parse across a loop; omit it for a
 * one-off check (re-reads the env each call).
 */
export function isDeniedHost(
  resource: string,
  deniedHosts: string[] = getDeniedHosts(),
): boolean {
  const r = resource.toLowerCase();
  return deniedHosts.some((host) => r.includes(host));
}
