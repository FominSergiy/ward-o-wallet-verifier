import { assertEquals } from "@std/assert";
import {
  blockDeadServiceIfStructural,
  DOMAIN_DEAD_CODES,
  isDomainDeadCode,
} from "./block.ts";

Deno.test("isDomainDeadCode: structural codes are dead; transient/config codes are not", () => {
  // Structural deadness — block on a single strike.
  assertEquals(isDomainDeadCode("target_api_is_not_x402_enabled"), true);
  assertEquals(isDomainDeadCode("not_found"), true);
  assertEquals(isDomainDeadCode("upstream_404"), true);
  assertEquals(isDomainDeadCode("unsubstituted_path_param"), true);
  assertEquals(isDomainDeadCode("descriptor_only_response"), true);

  // Transient or payer-side — must NOT one-strike block.
  assertEquals(isDomainDeadCode("timeout"), false);
  assertEquals(isDomainDeadCode("rate_limited"), false);
  assertEquals(isDomainDeadCode("non_json_response"), false); // could be 503 HTML
  assertEquals(
    isDomainDeadCode("payment_exceeds_maximum_allowed_value"),
    false,
  );
  assertEquals(isDomainDeadCode("cex_attribution_failed"), false);
  assertEquals(isDomainDeadCode(undefined), false);
  assertEquals(isDomainDeadCode(""), false);
});

Deno.test("DOMAIN_DEAD_CODES excludes payer-side and transient codes", () => {
  assertEquals(
    DOMAIN_DEAD_CODES.has("payment_exceeds_maximum_allowed_value"),
    false,
  );
  assertEquals(DOMAIN_DEAD_CODES.has("insufficient_balance"), false);
  assertEquals(DOMAIN_DEAD_CODES.has("timeout"), false);
});

Deno.test("blockDeadServiceIfStructural: no-op offline (DATABASE_URL unset) and never throws", () => {
  const prev = Deno.env.get("DATABASE_URL");
  Deno.env.delete("DATABASE_URL");
  try {
    // Both a dead code and a non-dead code must return without throwing; with no
    // DB configured getDb() is the no-op client.
    blockDeadServiceIfStructural(
      "https://x.example",
      "target_api_is_not_x402_enabled",
    );
    blockDeadServiceIfStructural("https://y.example", "timeout");
  } finally {
    if (prev === undefined) Deno.env.delete("DATABASE_URL");
    else Deno.env.set("DATABASE_URL", prev);
  }
});
