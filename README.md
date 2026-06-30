<h1>
  <img src="docs/assets/ward-o.svg" alt="WARD-o mascot" width="56" align="absmiddle" />
  ward-o-wallet-verifier
</h1>

[![CI](https://github.com/FominSergiy/ward-o-wallet-verifier/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/FominSergiy/ward-o-wallet-verifier/actions/workflows/ci.yml?query=branch%3Amain)

**A free wallet risk check for agents that spend money.** Hand WARD-o an EVM
wallet address and it returns a structured risk verdict — `safe_to_transact`,
`do_not_transact`, or `insufficient_data` — so your agent can decide whether to
proceed with a payment without a human poking around on Etherscan.

It's free to use. Every _deep_ check spends a few cents of USDC from the
operator's wallet; there's no plan, invoice, or signup for the web app. If it's
useful, you can [buy the author a coffee](https://buymeacoffee.com/sergiy_fomin)
— purely in kind.

## How it works

Two tiers:

- **Fast — free, ~1s, $0 spend.** A sanctions gate: a local denylist plus the
  Chainalysis on-chain oracle, fanned out across every supported EVM chain. A
  sanctioned address returns `do_not_transact` immediately, with no payment.
- **Deep — a few cents, slower.** Selects vetted risk services from a curated
  registry, invokes them in parallel — paying per call in USDC over the
  [x402 protocol](https://www.x402.org) via [Agnic's](https://agnic.ai) proxy —
  and reads free chain primitives (Chainalysis oracle, ENS, label registries)
  alongside. Claude (Opus) then weighs the evidence by category into a final
  structured verdict. When a provider misbehaves, the next ranked alternate is
  tried; a partial verdict still ships, and all paid receipts are returned even
  if synthesis fails.

The deep check **isn't instant** — it makes live calls to third-party data
sources and a language model. That's the honest trade for breadth of signal.

> **A note on x402 discovery.** Early versions re-discovered providers live via
> x402 on _every_ call. That was too slow for an interactive tool, so the hot
> path now selects from a curated, vetted **registry**
> ([src/registry/](src/registry/)); live x402 discovery moved to a background
> vetter that keeps the registry fresh. x402 is still the payment rail for the
> paid providers — it's just no longer in the request's critical path.

## Surfaces

HTTP API (mounted in [src/main.ts](src/main.ts)):

| Method | Path                                        | Purpose                                                                         |
| ------ | ------------------------------------------- | ------------------------------------------------------------------------------- |
| GET    | `/health`                                   | Liveness.                                                                       |
| POST   | `/discover`                                 | Discovery only — planned services + estimated cost. **No payments.**            |
| POST   | `/invoke`                                   | Discover + parallel paid invocation. Returns findings, receipts, total spend.   |
| POST   | `/verify-agent`                             | Full pipeline + pre-flight balance guard + LLM synthesis → final verdict. JSON. |
| POST   | `/verify-agent-stream`                      | Same, streamed as SSE (phase / service / verdict events).                       |
| POST   | `/request-key`                              | Mint a self-serve API key for the MCP server.                                   |
| GET    | `/api/blog/posts` · `/api/blog/posts/:slug` | Blog read API (feeds the site's `/blog`).                                       |
| POST   | `/mcp`                                      | MCP Streamable HTTP (bearer: an issued key, or `MCP_SHARED_SECRET`).            |

Also an **MCP server** — tools `verify_wallet` (fast/deep) and
`get_deep_verdict`, over stdio ([src/mcp/stdio.ts](src/mcp/stdio.ts)) and
Streamable HTTP ([src/mcp/http.ts](src/mcp/http.ts)) — and a **React product
site** ([web/](web/)): About, Verifier, Blog.

### Getting an MCP key

The web app is open and keyless. The MCP server needs a key — mint one (no
account):

```bash
curl -X POST http://localhost:8000/request-key
# → { "apiKey": "wardo_sk_…", "prefix": "wardo_sk_…", "note": "shown once" }
```

Pass it as the Bearer token when you add the server to your MCP client. Keys are
**attribution + revocation handles, not paywalls** — the product is free; the
key just lets the operator see usage and cut off abuse. Issued keys need
`DATABASE_URL` set.

## API example

```bash
curl -X POST http://localhost:8000/verify-agent \
  -H "Content-Type: application/json" \
  -d '{"address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}'
```

Request bodies share `{ address: "0x…" }`; `/verify-agent` accepts optional
`depth` (`fast` | `deep`, default `deep`) and `budgetCeiling`. Chain selection
is automatic. Route handlers live in [src/routes/](src/routes/).

## Quick start

```bash
cp .env.example .env
# fill in AGNIC_API_KEY

deno task dev
```

Then hit `/verify-agent` with the curl above.

## Prerequisites

- **Deno 2.x**
- **An Agnic API key** (`agnic_tok_…`) — one key powers both LLM calls and x402
  payments. The associated wallet must be funded with USDC on **Base** (or
  **Base Sepolia** for testing).
- **Optional `DATABASE_URL`** (Neon Postgres) — required only for the self-serve
  API keys, the blog, and durable metrics. Unset = the DB layer is a no-op and
  the app still serves the verifier.

Env vars: `AGNIC_API_KEY` is required; `AI_MODEL`, `SYNTHESIS_MODEL`,
`AGNIC_BUDGET_MIN_USD`, `ALLOWED_ORIGIN`, `PORT`, `MCP_SHARED_SECRET`,
`DATABASE_URL` are optional. See [.env.example](.env.example).

## Stack

- Runtime: Deno 2.x · HTTP: [Hono](https://hono.dev/) + Zod
- DB: Neon Postgres via `npm:postgres` (no-op when `DATABASE_URL` is unset)
- Chain reads: [viem](https://viem.sh/) · LLM + x402 settlement:
  [Agnic](https://agnic.ai) (OpenAI-compatible)
- Synthesis: Claude Opus; ranking: Claude Sonnet · MCP:
  `@modelcontextprotocol/sdk`

## Tasks

| Task                       | Command                                                |
| -------------------------- | ------------------------------------------------------ |
| Dev server (watch)         | `deno task dev`                                        |
| Tests (offline)            | `deno task test`                                       |
| Lint / format / type-check | `deno task lint` · `deno task fmt` · `deno task check` |
| DB migrations              | `deno task db:migrate` (needs `DATABASE_URL`)          |
| Post-deploy MCP smoke      | `WARDO_API_URL=… deno task mcp:smoke`                  |

## Deployment

| Surface        | Host                                                                                                            | URL pattern                   |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Backend API    | [Deno Deploy](https://deno.com/deploy) (entrypoint `src/main.ts`)                                               | `https://<project>.deno.dev`  |
| Frontend (web) | [Cloudflare Pages](https://pages.cloudflare.com/) (root `web/`, build `npm ci && npm run build`, output `dist`) | `https://<project>.pages.dev` |

Both auto-deploy from `main`. On Deno Deploy the filesystem is read-only, so the
service-health store falls back to an in-memory `Map` when `DENO_DEPLOYMENT_ID`
is present (cache resets on cold start — fine at current scale). Provisioning
runbook + env contract: [docs/deployment.md](docs/deployment.md).

## UI

A small Vite + React SPA in [web/](web/): an **About** landing page, the
**Verifier** (input a wallet, Fast Check or Deep Check, watch
phase/service/verdict events stream live), and a **Blog** backed by `/api/blog`.
See [web/README.md](web/README.md).
