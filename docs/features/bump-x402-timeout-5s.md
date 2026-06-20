# bump-x402-timeout-5s

## What

Bumped the default per-call timeout for x402 service invocation from **2000ms → 5000ms**. The 2s cap was tripping on virtually every real x402 call (observed median round-trip ~4.2s end-to-end including agnicFetch + payment + upstream), causing the entire paid-service fan-out to fall through to errors and degrading verdict quality.

## Files

- `src/agent/invoke_all.ts` — `DEFAULT_INVOKE_TIMEOUT_MS` now reads `INVOKE_TIMEOUT_MS` env with a `"5000"` fallback (was `"2000"`).

## Config

- `INVOKE_TIMEOUT_MS` env still overrides the default for ops/local tuning. No new env vars.

## Notes

- **Per-request `timeoutMs` from clients is deliberately NOT exposed** on `/verify-agent`, `/verify-agent-stream`, `/invoke`, or the MCP `verify_wallet` tool. Considered and deferred:
  - No caller exists today (web frontend + MCP tool don't pass it).
  - Pre-auth (W1.1 tenant API keys not landed), an open `timeoutMs` knob is an abuse vector — anyone can set `timeoutMs: 30000` and amplify cost on slow upstreams.
  - The per-x402-call timeout is only one of several latency budgets (`agnicFetch` 10s, ENS, Chainalysis RPC, eth-labels, LLM synthesis), so exposing it alone would be a misleading "request budget" knob.
  - Revisit after W1.1 so the knob can be gated to authenticated tenants with sane per-tenant caps.
- **No cassette re-record** — this change doesn't alter any recorded HTTP traffic (URLs, methods, bodies all identical).
- **E2E verified** against the Vitalik fixture (`0xd8dA…6045`): verdict `safe_to_transact` / `high`, 3 of 4 paid receipts ok at ~4.2s each, $0.011 spent. `service_observations` and `service_health_durable` both populated correctly (W0.8 + W0.3 writers confirmed live).
- **Same-turn follow-up**: `crypto-news-sentiment-api-628b81` was failing because our recorded `price_usdc: 0.005` was below the real upstream `maxAmountRequired: 0.010`, so agnic was rejecting with `Payment exceeds maximum allowed value` before the call ever ran (the 5s timeout was a red herring — the call wasn't slow, it was being short-circuited before the response came back). Bumped `price_usdc` to `0.012` (real $0.010 + 20% buffer) in both `data/call_recipes.json` and the `service_registry` row. Post-fix: 4/4 receipts ok on a fresh wallet, web_sentiment paid `$0.010` in 3.5s. Per-resource ceilings should track real `maxAmountRequired` from the x402 402 response — worth a follow-up to have the W0.10 vetter cron probe each resource and auto-adjust `price_usdc` if upstream has raised its price.
- **Minor**: `service_health_durable.last_error_code` is empty for the timed-out resource even though the matching `service_observations` row has a populated `error_code`. The error-code is being passed to the observation writer but not threaded into `recordError()`. Cosmetic — file a follow-up.
EOF