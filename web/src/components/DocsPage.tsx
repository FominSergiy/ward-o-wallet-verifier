import type { ReactNode } from "react";
import { navigate } from "../router";

interface CodeBlockProps {
  lang: string;
  children: string;
}

function Code({ lang, children }: CodeBlockProps) {
  return (
    <figure className="docs-code">
      <div className="docs-code-bar">
        <span>{lang}</span>
      </div>
      <pre>
        <code>{children}</code>
      </pre>
    </figure>
  );
}

function Inline({ children }: { children: ReactNode }) {
  return <code className="docs-inline">{children}</code>;
}

export function DocsPage() {
  return (
    <article className="docs">
      <header className="docs-header">
        <div className="docs-eyebrow">Project · Architectural overview</div>
        <h1>Ward-o Wallet Verifier</h1>
        <p className="docs-lede">
          One address in, one verdict out. Discover paid x402 risk services,
          fan out in parallel, fall back gracefully, synthesize with an LLM.
        </p>
      </header>

      <section className="docs-section">
        <div className="docs-eyebrow">00 — Overview</div>
        <h2>What it does</h2>
        <p>
          You hand Ward-o an EVM wallet address. It looks for risk-relevant
          paid services in the Coinbase x402 bazaar, picks one per category,
          pays them in USDC on Base, and asks Claude to weigh the evidence.
          You get back a structured verdict —{" "}
          <Inline>safe_to_transact</Inline>, <Inline>do_not_transact</Inline>,
          or <Inline>insufficient_data</Inline> — plus on-chain receipts for
          every paid call.
        </p>
        <p>
          The whole thing runs on Deno + Hono, talks to the Agnic gateway for
          both LLM inference and x402 settlement, and exposes itself three
          ways: a streaming HTTP API, an MCP server, and the React UI you're
          reading this on.
        </p>
      </section>

      <section className="docs-section">
        <div className="docs-eyebrow">01 — Surfaces</div>
        <h2>Three ways to talk to it</h2>
        <p>
          Same pipeline behind every surface. The frontend is pure
          presentation; the API and MCP server are peers, not layers.
        </p>

        <h3>Frontend (this page)</h3>
        <p>
          A Vite + React SPA that streams Server-Sent Events from the backend
          and renders them as a live terminal log plus structured cards. No
          business logic lives here — it's a thin window on top of{" "}
          <Inline>/verify-agent-stream</Inline>.
        </p>
        <Code lang="typescript">
          {`export function streamVerify(
  address: string,
  onEvent: (e: VerifyEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return consumeSSE("/verify-agent-stream", { address }, onEvent, signal);
}`}
        </Code>

        <h3>Standalone HTTP API</h3>
        <p>
          The same handler powers the UI, a curl call, or any custom agent.
          A pre-flight budget guard is the first thing it does — if the
          Agnic wallet is too thin to cover the verify run, it bails with a
          clean <Inline>503 budget_exhausted</Inline> instead of half-paying
          for services.
        </p>
        <Code lang="typescript">
          {`router.post("/", zValidator("json", VerifyAgentRequestSchema), async (c) => {
  const { budgetCeiling, ...req } = c.req.valid("json");

  const threshold = budgetThreshold();
  const budget = await fetchBudget();
  if (budget !== null && budget.totalBalance < threshold) {
    return c.json({
      error: "budget_exhausted",
      message: \`Agnic budget is below the pre-flight threshold ...\`,
      totalBalance: budget.totalBalance,
      threshold,
    }, 503);
  }

  const result = await verifyAgent(req, { budgetCeiling });
  return c.json({ verdict: result.verdict, receipts: ..., ... });
});`}
        </Code>
        <p className="docs-routes-intro">Other routes — same module:</p>
        <ul className="docs-routes">
          <li>
            <Inline>POST /discover</Inline> — discovery-only, no payment.
          </li>
          <li>
            <Inline>POST /discover-stream</Inline> — SSE variant.
          </li>
          <li>
            <Inline>POST /invoke</Inline> — discover + invoke, no synthesis.
          </li>
          <li>
            <Inline>POST /verify-agent</Inline> — full pipeline, JSON
            response.
          </li>
          <li>
            <Inline>POST /verify-agent-stream</Inline> — full pipeline, SSE.
          </li>
          <li>
            <Inline>POST /mcp</Inline> — MCP Streamable HTTP, bearer-gated.
          </li>
        </ul>

        <h3>MCP server</h3>
        <p>
          One tool today: <Inline>verify_wallet</Inline>. A
          transport-agnostic factory builds an <Inline>McpServer</Inline>{" "}
          that both <Inline>stdio.ts</Inline> and <Inline>http.ts</Inline>{" "}
          mount — same tool surface, different wire.
        </p>
        <Code lang="typescript">
          {`export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "ward-o-wallet-verifier",
    version: "0.1.0",
  });

  server.registerTool(
    "verify_wallet",
    {
      title: "Verify wallet risk",
      description:
        "Run the full Ward-o pipeline: discover x402 risk services, " +
        "pay for them, and synthesize a verdict.",
      inputSchema: {
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        budgetCeiling: z.number().positive().optional(),
        categories: z.array(CategorySchema).optional(),
      },
    },
    async ({ address, budgetCeiling, categories }) => {
      const result = await verifyAgent(
        { address },
        { budgetCeiling, categories },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result.verdict, null, 2) }],
        structuredContent: result.verdict,
      };
    },
  );

  return server;
}`}
        </Code>
        <p>
          The HTTP transport is gated by an <Inline>MCP_SHARED_SECRET</Inline>{" "}
          bearer token; if it's unset the route returns{" "}
          <Inline>503 mcp_disabled</Inline> so you can ship the binary
          without accidentally exposing the tool.
        </p>
      </section>

      <section className="docs-section">
        <div className="docs-eyebrow">02 — Pipeline</div>
        <h2>Discovery → verify</h2>
        <p>
          The work happens in two acts. <em>Discovery</em> finds candidate
          paid services and picks one per category. <em>Verify</em> pays
          them in parallel, falls back when they misbehave, and hands the
          evidence to an LLM for synthesis.
        </p>

        <h3>1 · Discover</h3>
        <p>
          Detect the wallet network, fetch candidates per category, rerank
          with an LLM, build a fallback list, and total the estimated cost.
          The whole orchestrator is small on purpose — easy to swap any
          step in tests.
        </p>
        <Code lang="typescript">
          {`export async function discover(
  address: string,
  categories: Category[],
  opts: DiscoverOpts = {},
): Promise<DiscoveryPlan> {
  const walletNetwork = await detect();

  const candidates = await fetcher(categories, walletNetwork, {
    limit: opts.limit,
    maxUsdPrice: opts.maxUsdPrice,
  });

  const services: RankedService[] = await ranker(candidates, llm);
  const alternates = buildAlternates(candidates, services, walletNetwork);

  return {
    address, walletNetwork, services, alternates,
    totalEstimatedCostUsdc: services.reduce((s, x) => s + x.priceUsdc, 0),
    unresolvedCategories, deterministicSources: ...,
  };
}`}
        </Code>

        <h3>2 · Fan-out</h3>
        <p>
          One search query per requested category, all in flight at once.
          A failed or empty category records an error but never kills the
          run — we'd rather return a partial verdict than nothing.
        </p>
        <Code lang="typescript">
          {`const entries = Object.entries(queries) as [Category, string][];
const settled = await Promise.all(
  entries.map(async ([cat, query]): Promise<Outcome> => {
    try {
      const r = await client(
        { query, network: caip2, limit: opts.limit, maxUsdPrice: opts.maxUsdPrice },
        opts.fetchFn,
      );
      return { cat, ok: true, entries: r };
    } catch (e) {
      return { cat, ok: false, error: (e as Error).message };
    }
  }),
);`}
        </Code>

        <h3>3 · Rerank with graceful fallback</h3>
        <p>
          An LLM picks the best service per category against an ordered
          list of criteria — roughly:
        </p>
        <ol className="docs-criteria">
          <li>Recent failure rate (durably blocked → out).</li>
          <li>Quality signals (unique payers, l30d call volume).</li>
          <li>Price (cheap wins ties).</li>
          <li>Coverage match against the requested category.</li>
          <li>Host diversity (don't stack one provider).</li>
          <li>Soft entity-attribution signals on labels.</li>
          <li>Schema sanity (input we can actually fill).</li>
        </ol>
        <p>
          If the LLM call fails or returns junk, we don't die — we sort by
          quality desc, price asc, and ship that pick instead.
        </p>
        <Code lang="typescript">
          {`try {
  const prompt = buildPrompt(filteredCandidates, network);
  selection = await llm.generateStructured(RankedSelectionSchema, prompt, { ... });
} catch (e) {
  console.warn(\`[rank] LLM rerank failed, falling back to quality-sort: \${e.message}\`);
}

if (selection) {
  for (const s of selection.selections) {
    out.push(toRanked(s.category, list[s.resourceIndex], network, s.rationale));
  }
} else {
  for (const [cat, list] of entries) {
    const idx = fallbackPick(list, network, cat);
    out.push(toRanked(cat, list[idx], network, "Fallback: highest usage, lowest price."));
  }
}`}
        </Code>

        <h3>4 · Invoke with per-host fallback</h3>
        <p>
          The primary service goes first. If it fails, we walk the
          alternates the discoverer prepared. If the failure looks
          domain-level (DNS, 404, host completely down), we add the host
          to a blocklist and skip every sibling service from the same
          provider in this run.
        </p>
        <Code lang="typescript">
          {`for (let i = 0; i < candidates.length; i++) {
  const svc = candidates[i];
  const host = hostOf(svc.resource);
  if (failedHosts.has(host)) {
    console.warn(\`[invoke] skipping \${svc.resource} — host \${host} already failed\`);
    continue;
  }

  const outcome = await invoker(svc, address, chain, { llm });

  if (outcome.status === "ok" || outcome.status === "fallback_ok") {
    recordOk(svc.resource);
    return outcome;
  }

  recordError(svc.resource, outcome.error ?? "(unknown)", outcome.errorCode);
  if (isDomainLevelError(outcome.error)) {
    failedHosts.add(host);
  }
}`}
        </Code>

        <h3>5 · Durable health store</h3>
        <p>
          Some failures are one-strike-and-out: malformed catalog entries
          with literal <Inline>:endpoint</Inline> placeholders, HTML error
          pages from non-x402 upstreams, descriptor roots with no usable
          action. Retrying those is wasted USDC, so the ranker filters
          them on every subsequent run until the store is reset. Soft
          quality demotion (empty payloads on rich-history wallets) is
          time-windowed at 7 days.
        </p>
        <Code lang="typescript">
          {`const DURABLE_BLOCK_CODES = new Set([
  "payment_exceeds_max",
  "not_found",
  "unsubstituted_path_param",
  "descriptor_only_response",
  "non_json_response",
]);`}
        </Code>

        <h3>6 · AI synthesis (and a chain-primitive short-circuit)</h3>
        <p>
          Before we spend a cent on x402, we hit the Chainalysis sanctions
          oracle on every supported EVM chain in parallel. If any chain
          flags the address, we short-circuit to a deterministic verdict
          — zero x402 spend, instant{" "}
          <Inline>do_not_transact</Inline>. The expensive LLM synthesis
          only runs when the cheap deterministic checks come back clean.
        </p>
        <Code lang="typescript">
          {`const oracleAttempts = await checkOracleAcrossChains(
  req.address,
  oracleCheckFn,
  emit,
);
const flaggedAttempt = oracleAttempts.find(
  (a) => a.result?.isSanctioned === true,
);
if (flaggedAttempt && flaggedAttempt.result) {
  console.warn(\`[verify-agent] oracle flagged \${req.address} — short-circuiting\`);
  return {
    verdict: oracleSanctionedVerdict(req, categories, notApplicable, flaggedAttempt.result),
    plan: { ...empty plan... },
    outcomes: [],
    walletNetwork: "base",
    totalSpentUsdc: 0,
  };
}`}
        </Code>
      </section>

      <section className="docs-section">
        <div className="docs-eyebrow">03 — Project</div>
        <h2>Stack &amp; team</h2>
        <ul className="docs-bullets">
          <li>
            <strong>Runtime:</strong> Deno + Hono on the backend, Vite +
            React on the frontend.
          </li>
          <li>
            <strong>Payments:</strong> x402 via the Coinbase bazaar,
            settled in USDC on Base through the Agnic gateway.
          </li>
          <li>
            <strong>LLM:</strong> Claude (Opus for synthesis, smaller
            models for reranking) via the Agnic OpenAI-compatible
            endpoint.
          </li>
          <li>
            <strong>Hosting:</strong> Deno Deploy for the API, Cloudflare
            Pages for the frontend.
          </li>
          <li>
            <strong>Integrations:</strong> Model Context Protocol SDK for
            the MCP tool surface.
          </li>
          <li>
            <strong>Team:</strong> one full-stack engineer in Toronto,
            focused on agentic workflows.
          </li>
        </ul>
      </section>

      <section className="docs-section">
        <div className="docs-eyebrow">04 — Honest scorecard</div>
        <h2>What's working</h2>
        <ul className="docs-bullets">
          <li>
            <strong>Real payments, real receipts.</strong> The discovery
            pipeline actually pays for live x402 services and surfaces
            the transaction hashes back to the UI. Nothing simulated.
          </li>
          <li>
            <strong>Graceful degradation.</strong> Per-host blocklisting
            plus durable + time-windowed health demotion means a flaky
            merchant doesn't poison the run — alternates take over and
            the verdict still ships.
          </li>
          <li>
            <strong>Streaming end-to-end.</strong> Every phase emits SSE
            events, so the UI and any subscribed agent see services
            start, pay, succeed, or fall back in real time.
          </li>
        </ul>

        <h2>What's not</h2>
        <ul className="docs-bullets">
          <li>
            <strong>Discovery latency.</strong> The full discover →
            rerank → invoke loop is slower than it should be for an
            interactive tool. Most of the cost is in dynamic discovery
            and in the LLM guessing input parameters for services we've
            never seen before.
          </li>
          <li>
            <strong>Param guessing.</strong> Every paid call where we
            have to infer the request body adds wall-clock time and
            another LLM hop. The wins are at the edges — when we already
            know a service and can fire a deterministic body, we're
            sub-second.
          </li>
          <li>
            <strong>The fix:</strong> hit known-good services with
            cached, deterministic request bodies first, and only fan out
            into discovery when those miss. The current code leans
            heavily on dynamic discovery for novelty's sake.
          </li>
        </ul>

        <h2>What's next</h2>
        <ul className="docs-bullets">
          <li>
            Share with the dev and crypto communities and collect
            feedback — what's interesting, what's broken, what they'd
            actually pay for.
          </li>
          <li>
            Decide which way to lean: further into dynamic bazaar
            discovery, or further into curated determinism on the known
            services. The latency answer probably picks for us.
          </li>
        </ul>
      </section>

      <footer className="docs-footer">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          ← Back to the app
        </a>
      </footer>
    </article>
  );
}
