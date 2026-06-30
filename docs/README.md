# docs/

Engineering notes for the WARD-o wallet verifier. Top-level
[README.md](../README.md) covers the product pitch + quick start; the agent
contract lives in [../CLAUDE.md](../CLAUDE.md). This index exists so a
cold-start reader (human or agent) can orient in one screen.

## Structure

- [features/](features/) — one Markdown file per completed feature
  (`<slug>.md`). Each follows the `What / Files / Config / Notes` shape from
  CLAUDE.md's "Agent memory" rule. Read these before changing a subsystem you
  don't own.
- [plans/planned/](plans/planned/) — tickets staged for execution. Each ticket
  includes acceptance criteria, validation commands, and a test spec.
- [plans/completed/](plans/completed/) — archived plans, kept for the
  why-behind-the-shape.
- [agent-log.md](agent-log.md) — append-only index of completed features (date,
  slug, one-liner). Slug column matches `features/<slug>.md`.
- [deployment.md](deployment.md) — provisioning runbook + env-var contract for
  Deno Deploy and Cloudflare Pages.
- [assets/](assets/) — mascots + the UI screenshot rendered in the top-level
  README.
- [archive/](archive/) — hackathon-era artifacts kept for history: the pitch
  decks (`WARD-o*.html/.pptx`), `research/` (exploratory notes), and
  `real-wallet-tests/` (fixture wallets + per-run reports).

## Code map

Mirror of the **Surfaces** section in [../CLAUDE.md](../CLAUDE.md) — see there
for the per-route table and MCP transports.

- [`src/agent/`](../src/agent/) — verify pipeline orchestrator, LLM synthesis,
  chain primitives (Chainalysis oracle, ENS, eth-labels registry).
- [`src/discovery/`](../src/discovery/) — x402 fanout, LLM rerank, durable
  health store, deterministic-sources builder.
- [`src/routes/`](../src/routes/) — Hono HTTP handlers.
- [`src/mcp/`](../src/mcp/) — MCP transports (stdio + Streamable HTTP) + tool
  registration.
- [`src/clients/agnic.ts`](../src/clients/agnic.ts) — Agnic gateway client
  (LLM + x402 proxy).
- [`web/`](../web/) — Vite + React single-page UI. Screenshot in
  [../README.md#ui](../README.md#ui).
