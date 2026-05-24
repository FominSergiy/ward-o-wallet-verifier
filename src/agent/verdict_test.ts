import { assertEquals, assertThrows } from "@std/assert";
import { WalletVerdictSchema } from "./verdict.ts";

const SAFE_FIXTURE = {
  address: "0x9dd5e3a608Ba321C5205688d66E11e81B67e08c2",
  chain: "base",
  safe: true,
  verdict: "safe_to_transact",
  confidence: "high",
  headline: "Wallet appears safe — long history, exchange label, no sanctions.",
  reasoning: "Sanctions screen clean. Labeled as exchange entity. Long on-chain history with high tx count. No negative web sentiment hits.",
  findings: [
    { category: "sanctions", severity: "info", finding: "Not on any sanctions list." },
    { category: "labels", severity: "info", finding: "Tagged as verified exchange." },
    { category: "onchain_history", severity: "info", finding: ">100 txs over 18 months." },
  ],
  coverage: {
    requested: ["sanctions", "labels", "onchain_history", "web_sentiment"],
    resolved: ["sanctions", "labels", "onchain_history"],
    unresolved: ["web_sentiment"],
  },
  totalSpentUsdc: 0.012,
  generatedAt: "2026-05-21T15:00:00.000Z",
};

const SANCTIONED_FIXTURE = {
  ...SAFE_FIXTURE,
  safe: false,
  verdict: "do_not_transact",
  confidence: "high",
  headline: "Wallet appears on OFAC SDN — DO NOT transact.",
  reasoning: "Sanctions hit on OFAC SDN list. Hard veto applies; other signals not considered.",
  findings: [
    { category: "sanctions", severity: "critical", finding: "Matched OFAC SDN list." },
  ],
};

const INSUFFICIENT_FIXTURE = {
  ...SAFE_FIXTURE,
  safe: false,
  verdict: "insufficient_data",
  confidence: "low",
  headline: "Not enough signals to issue a verdict.",
  reasoning: "Only ENS data returned; primary risk categories failed or unresolved.",
  findings: [],
  coverage: {
    requested: ["sanctions", "labels"],
    resolved: [],
    unresolved: ["sanctions", "labels"],
  },
};

Deno.test("WalletVerdictSchema parses safe wallet fixture", () => {
  const parsed = WalletVerdictSchema.parse(SAFE_FIXTURE);
  assertEquals(parsed.safe, true);
  assertEquals(parsed.verdict, "safe_to_transact");
  assertEquals(parsed.findings.length, 3);
});

Deno.test("WalletVerdictSchema parses sanctioned wallet fixture", () => {
  const parsed = WalletVerdictSchema.parse(SANCTIONED_FIXTURE);
  assertEquals(parsed.safe, false);
  assertEquals(parsed.verdict, "do_not_transact");
  assertEquals(parsed.findings[0].severity, "critical");
});

Deno.test("WalletVerdictSchema parses insufficient_data fixture", () => {
  const parsed = WalletVerdictSchema.parse(INSUFFICIENT_FIXTURE);
  assertEquals(parsed.safe, false);
  assertEquals(parsed.verdict, "insufficient_data");
  assertEquals(parsed.confidence, "low");
});

Deno.test("WalletVerdictSchema rejects invalid verdict enum", () => {
  assertThrows(() =>
    WalletVerdictSchema.parse({ ...SAFE_FIXTURE, verdict: "maybe" })
  );
});

Deno.test("WalletVerdictSchema rejects invalid category in findings", () => {
  assertThrows(() =>
    WalletVerdictSchema.parse({
      ...SAFE_FIXTURE,
      findings: [{ category: "bogus", severity: "info", finding: "x" }],
    })
  );
});

Deno.test("WalletVerdictSchema rejects missing required field", () => {
  const { safe: _safe, ...rest } = SAFE_FIXTURE;
  assertThrows(() => WalletVerdictSchema.parse(rest));
});
