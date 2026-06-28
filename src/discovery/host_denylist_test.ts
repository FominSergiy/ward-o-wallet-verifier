import { assertEquals } from "@std/assert";
import { getDeniedHosts, isDeniedHost } from "./host_denylist.ts";

// Pin DISCOVERY_HOST_DENYLIST for one test body, restoring the prior value.
function withDenylist<T>(value: string | null, fn: () => T): T {
  const prev = Deno.env.get("DISCOVERY_HOST_DENYLIST");
  if (value === null) Deno.env.delete("DISCOVERY_HOST_DENYLIST");
  else Deno.env.set("DISCOVERY_HOST_DENYLIST", value);
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete("DISCOVERY_HOST_DENYLIST");
    else Deno.env.set("DISCOVERY_HOST_DENYLIST", prev);
  }
}

Deno.test("getDeniedHosts: defaults to orbisapi.com when env unset", () => {
  withDenylist(null, () => {
    assertEquals(getDeniedHosts(), ["orbisapi.com"]);
  });
});

Deno.test("getDeniedHosts: parses, trims, lowercases, drops empties", () => {
  withDenylist(" Foo.com , bar.io ,, ", () => {
    assertEquals(getDeniedHosts(), ["foo.com", "bar.io"]);
  });
});

Deno.test("isDeniedHost: matches the default orbis host as a substring", () => {
  withDenylist(null, () => {
    assertEquals(
      isDeniedHost("https://orbisapi.com/proxy/address-risk-api-296f15"),
      true,
    );
    assertEquals(isDeniedHost("https://api.anchor-x402.com/v1/screen"), false);
  });
});

Deno.test("isDeniedHost: env override replaces the default set", () => {
  withDenylist("evil.example", () => {
    // Custom host is denied...
    assertEquals(isDeniedHost("https://evil.example/x"), true);
    // ...and orbis is NOT denied anymore (default replaced, not extended).
    assertEquals(isDeniedHost("https://orbisapi.com/proxy/x"), false);
  });
});
