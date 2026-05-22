# agnic-agent-wallet-verifier

Backend service for **autonomous-agent wallet risk verification**. Hand it a wallet address + EVM chain and it returns a structured risk verdict — so your agent can decide whether to proceed with a payment or interaction without a human poking around on Etherscan.

The novel bit: instead of hard-coding a fixed list of intel providers, the service **discovers** relevant third-party services at runtime via the [x402 protocol](https://www.x402.org) and **pays for them on-demand** with USDC micropayments. New services that publish themselves to the x402 directory become available automatically.

## How it works

Three-stage pipeline:

- **Discover** — fan out to [CDP's x402 discovery search](https://api.cdp.coinbase.com/platform/v2/x402/discovery/search) for each risk category (sanctions, entity labels, on-chain history, web sentiment, contract analysis). An LLM reranks candidates by relevance and quality; a durable health store filters out services that have recently failed payment or returned errors.
- **Pay & invoke** — call the selected services in parallel through [Agnic's](https://agnic.ai) x402 proxy (`/api/x402/fetch?url=…&maxValue=…`), which handles the USDC payment handshake. A pre-flight balance check on `/verify-agent` aborts with `503` if the wallet can't cover the run. When a primary service fails, the next ranked alternate is tried automatically.
- **Synthesize** — Claude Opus (default `anthropic/claude-opus-4.7`, overridable via `SYNTHESIS_MODEL`) reads the findings and emits a structured `WalletVerdict` (`safe` / `risk_flag` / `insufficient_data`). All paid receipts are returned even if synthesis fails, so no spend is lost.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness check. |
| POST | `/discover` | Run the discovery stage only. Returns planned services, ranked alternates, and estimated USDC cost. **No payments.** |
| POST | `/invoke` | Run discovery + parallel paid invocation across all selected categories. Returns findings, receipts, and total spend. |
| POST | `/verify-agent` | Same as `/invoke` plus a pre-flight balance guard and LLM synthesis into a final verdict. The endpoint your agent calls. |

Request bodies all share `{ address: "0x…", chain: "eth" | "base" | … }`; `/discover` and `/invoke` accept an optional `categories` array, `/verify-agent` accepts an optional `budgetCeiling` (USDC).

Example:

```bash
curl -X POST http://localhost:8000/verify-agent \
  -H "Content-Type: application/json" \
  -d '{"address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","chain":"eth"}'
```

Route handlers live in [src/routes/](src/routes/) — look there for the exact request/response shapes.

## Quick start

```bash
cp .env.example .env
# fill in AGNIC_API_KEY

deno task dev
```

Then hit `/verify-agent` with the curl above.

## Prerequisites

- **Deno 2.x**
- **An Agnic API key** (`agnic_tok_…`) — one key powers both LLM calls and x402 payments. The associated wallet must be funded with USDC on **Base** (or **Base Sepolia** for testing). No other API keys or per-service URLs are required — endpoints come from x402 discovery at runtime.

Env vars: `AGNIC_API_KEY` is required; `AI_MODEL`, `SYNTHESIS_MODEL`, `AGNIC_BUDGET_MIN_USD`, `ALLOWED_ORIGIN`, `PORT` are optional. See [.env.example](.env.example) for defaults.

## Stack

- Runtime: Deno 2.x
- HTTP: [Hono](https://hono.dev/) + Zod validation
- Chain reads: [viem](https://viem.sh/)
- LLM gateway + x402 payment proxy: [Agnic](https://agnic.ai) (OpenAI-compatible, OpenRouter model IDs)
- Synthesis: Claude Opus; ranking/adapter: Claude Sonnet

## Tasks

| Task | Command |
|------|---------|
| Dev server (watch) | `deno task dev` |
| Run server | `deno task start` |
| Tests | `deno task test` |
| Lint | `deno task lint` |
| Format | `deno task fmt` |
| Type-check | `deno task check` |

## Roadmap

- **Coming soon — frontend.** A small Vite + React UI over this API so a human can drive a verification end-to-end, see the discovery plan, watch services resolve in real time, and read the final verdict. In progress.
