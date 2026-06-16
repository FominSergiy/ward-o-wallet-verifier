# Pivot tickets — wallet verifier → defensible product

These tickets break down the strategic pivot plan: ship the wallet verifier as a paid wedge optimized for agent dev platforms, instrument it from day one for the service-reputation moat, and keep schemas forward-compatible with a future on-chain wallet risk classifier.

The full strategy doc lives in the planning workspace at `~/.claude/plans/context-i-want-to-bubbly-liskov.md`. Each ticket here is self-contained and can be executed independently of the others in its workstream, provided its declared dependencies are satisfied.

## Decisions locked in

- **First buyer = agent dev platforms.** MCP-first, dev-style pricing, "drop into your agent in 10 lines."
- **Solo, hosted services preferred.** Reach for Supabase, Stripe, Cloudflare by default; self-host only when the benefit clearly outweighs the cost.
- **Two billing rails:** MCP routes via Stripe + API key. HTTP `/verify-agent` via x402 (WARD-o self-listed in Bazaar).
- **Latency before features.** Workstream −1 and 0 must land before any commercial work.

## Workstreams

| ID | Name | Purpose |
|----|------|---------|
| W−1 | Telemetry baseline | Measure before changing. Plumb duration + cost + request_id, capture v8 baseline, build replay cassettes, snapshot call recipes. |
| W0 | Latency foundation | Move discovery out of the hot path. Curated registry, durable bad-services store, score-based ranker, background vetter, synthesis swap to Haiku/Sonnet, verdict cache. Target: P95 <5s. |
| W1 | Sellable wedge | Tenant + API key, usage meter, Stripe + x402 dual-rail billing, locked verdict schema, integration recipes. |
| W2 | Reputation instrumentation | Extend observations with severity contribution + outcome feedback; capture synthesis trace; internal v0 service score endpoint. |
| W3 | Productization | Status page, docs site, pricing page, public playground, privacy doc. |
| W4 | Long-horizon graph model | Forward-compat audit only. Real implementation gated on accumulated outcome data. |

## Dependency graph

```
W−1.1 ─┬─ W−1.2
       ├─ W−1.3
       └─ W−1.4

W0.1 ─┬─ W0.2 (needs W−1.4) ─┬─ W0.4 ─┬─ W0.5
      ├─ W0.3 ───────────────┘        ├─ W0.6 (needs W−1.3)
      └─ W0.8 (needs W−1.1)           ├─ W0.7
                │                     └─ W0.9 ─ W0.10
                └─ W0.9

W1.1 (needs W0.1) ─┬─ W1.2 ─┬─ W1.3
                   │        └─ W1.5 (needs W0.10) ─ W1.6 ─ W1.7
                   └─ W1.8
W1.4 — independent, can run early

W2.1 (needs W0.8)
W2.2 (needs W1.1)
W2.3 (needs W0.6)
W2.4 (needs W0.9 + W2.1 + W2.3)

W3.1 (needs W1.2)
W3.2 (needs W1.4)
W3.3 (needs W1.3)
W3.4 (needs W1.1)
W3.5 — independent

W4.0 (needs W2.1 + W2.2)
```

## Tickets

### Workstream −1 — Telemetry baseline

- [W−1.1 — Event schema overhaul](W-1.1-event-schema-overhaul.md)
- [W−1.2 — Baseline benchmark](W-1.2-baseline-benchmark.md)
- [W−1.3 — Cassette replay test mode](W-1.3-cassette-replay-tests.md)
- [W−1.4 — Snapshot call recipes](W-1.4-snapshot-call-recipes.md)

### Workstream 0 — Latency foundation

- [W0.1 — Postgres infrastructure](W0.1-postgres-infrastructure.md)
- [W0.2 — Curated service registry](W0.2-curated-service-registry.md)
- [W0.3 — Durable bad-services store](W0.3-durable-bad-services-store.md)
- [W0.4 — Hot-path discovery swap](W0.4-hot-path-discovery-swap.md)
- [W0.5 — Per-call timeouts + ENS/eth-labels caching](W0.5-per-call-timeouts-caching.md)
- [W0.6 — Hot-path synthesis swap](W0.6-hot-path-synthesis-swap.md)
- [W0.7 — Verdict cache in KV](W0.7-verdict-cache.md)
- [W0.8 — service_observations writer](W0.8-service-observations-writer.md)
- [W0.9 — Score-based ranker](W0.9-score-based-ranker.md)
- [W0.10 — Background vetter job](W0.10-background-vetter-job.md)

### Workstream 1 — Sellable wedge

- [W1.1 — Tenant + API key model](W1.1-tenant-api-key-model.md)
- [W1.2 — Usage meter writer](W1.2-usage-meter-writer.md)
- [W1.3 — Stripe billing integration](W1.3-stripe-billing-integration.md)
- [W1.4 — Hardened verdict contract](W1.4-hardened-verdict-contract.md)
- [W1.5 — WARD-o x402 self-listing](W1.5-x402-self-listing.md)
- [W1.6 — x402 payment receiver](W1.6-x402-payment-receiver.md)
- [W1.7 — Cost-based price republishing](W1.7-cost-based-price-republishing.md)
- [W1.8 — Integration recipes](W1.8-integration-recipes.md)

### Workstream 2 — Reputation instrumentation

- [W2.1 — Extend service_observations for severity contribution](W2.1-extend-observations-severity.md)
- [W2.2 — Agent outcome feedback endpoint](W2.2-agent-outcome-feedback.md)
- [W2.3 — Synthesis trace capture](W2.3-synthesis-trace-capture.md)
- [W2.4 — Internal v0 service score endpoint](W2.4-internal-service-score-endpoint.md)

### Workstream 3 — Productization

- [W3.1 — Status page](W3.1-status-page.md)
- [W3.2 — Docs site](W3.2-docs-site.md)
- [W3.3 — Pricing page](W3.3-pricing-page.md)
- [W3.4 — Public landing playground](W3.4-public-playground.md)
- [W3.5 — Data retention + privacy doc](W3.5-privacy-doc.md)

### Workstream 4 — Long-horizon graph model

- [W4.0 — Schema forward-compatibility audit](W4.0-schema-forward-compatibility-audit.md)

## Suggested first picks

If a pickup agent is choosing what to start on:

1. **W−1.1** — unlocks W−1.2/3/4 + W0.8. Touches event types only, low risk.
2. **W0.1** — unlocks every W0/W1/W2 ticket that needs Postgres. Mostly infra setup.
3. **W1.4** — independent, low-effort, makes the public API contract real.

Avoid starting W0.4 until W0.2 and W0.3 are both done — that's the architectural flip and benefits from having the registry + durable store live first.
