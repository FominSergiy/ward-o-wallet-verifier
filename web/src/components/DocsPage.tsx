import type { ReactNode } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import "highlight.js/styles/atom-one-dark.min.css";
import { navigate } from "../router";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);

interface CodeBlockProps {
  lang: string;
  children: string;
}

function Code({ lang, children }: CodeBlockProps) {
  const highlighted =
    hljs.highlight(children.trim(), { language: lang, ignoreIllegals: true })
      .value;
  return (
    <figure className="docs-code">
      <div className="docs-code-bar">
        <span>{lang}</span>
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
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
          One address in, one verdict out. A free sanctions gate first; then, on
          demand, paid risk providers from a curated registry — fanned out in
          parallel, with graceful fallback — synthesized by an LLM.
        </p>
      </header>

      <section className="docs-section">
        <div className="docs-eyebrow">00 — Overview</div>
        <h2>What it does</h2>
        <p>
          You hand Ward-o an EVM wallet address. A free <em>fast</em>{" "}
          tier screens it against a sanctions denylist and the Chainalysis
          on-chain oracle in about a second, at zero spend. If you want the full
          picture, the <em>deep</em>{" "}
          tier selects risk providers from a curated registry, pays them per
          call in USDC, reads free chain primitives alongside, and asks an LLM
          to weigh the evidence. You get back a structured verdict —{" "}
          <Inline>safe_to_transact</Inline>,{" "}
          <Inline>do_not_transact</Inline>, or{" "}
          <Inline>insufficient_data</Inline>{" "}
          — plus on-chain receipts for every paid call. The deep tier isn't
          instant: it makes live third-party and LLM calls, and we'd rather be
          honest about that.
        </p>
        <p>
          The whole thing runs on Deno + Hono, talks to the Agnic gateway for
          both LLM inference and x402 settlement, and exposes itself three ways:
          an HTTP API (both streaming SSE and plain JSON), an MCP server, and
          the React UI you're reading this on.
        </p>

        <figure className="docs-flow">
          <svg
            viewBox="0 0 760 130"
            role="img"
            aria-label="Discovery to verify pipeline"
          >
            <defs>
              <marker
                id="docs-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerUnits="strokeWidth"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {/* Boxes — each width sized to its label, 22px gaps between, 10px margins */}
            {[
              { x: 10, w: 70, label: "address" },
              { x: 102, w: 115, label: "detect network" },
              { x: 239, w: 130, label: "discover + rerank" },
              { x: 391, w: 130, label: "invoke (parallel)" },
              { x: 543, w: 115, label: "LLM synthesis" },
              { x: 680, w: 70, label: "verdict" },
            ].map((b) => (
              <g key={b.label}>
                <rect
                  x={b.x}
                  y={45}
                  width={b.w}
                  height={40}
                  rx={4}
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity="0.4"
                />
                <text
                  x={b.x + b.w / 2}
                  y={70}
                  textAnchor="middle"
                  fill="currentColor"
                  fontSize="11"
                  fontFamily="Menlo, monospace"
                >
                  {b.label}
                </text>
              </g>
            ))}
            {/* Arrows — x1 = prevRight+1, x2 = nextLeft-1 so tip lands on box edge */}
            {[
              { x1: 81, x2: 101 },
              { x1: 218, x2: 238 },
              { x1: 370, x2: 390 },
              { x1: 522, x2: 542 },
              { x1: 659, x2: 679 },
            ].map((a, i) => (
              <line
                key={i}
                x1={a.x1}
                y1={65}
                x2={a.x2}
                y2={65}
                stroke="currentColor"
                strokeOpacity="0.5"
                strokeWidth="1.2"
                markerEnd="url(#docs-arrow)"
              />
            ))}
            {/* Fanout fan above invoke (center x=456) */}
            <g
              stroke="currentColor"
              strokeOpacity="0.25"
              strokeDasharray="2 3"
              strokeWidth="1"
            >
              <line x1={456} y1={45} x2={441} y2={20} />
              <line x1={456} y1={45} x2={456} y2={18} />
              <line x1={456} y1={45} x2={471} y2={20} />
            </g>
            <text
              x={456}
              y={14}
              textAnchor="middle"
              fill="currentColor"
              fillOpacity="0.55"
              fontSize="9"
              fontFamily="Menlo, monospace"
            >
              N services
            </text>
            {/* Short-circuit branch under discover + rerank (center x=304) */}
            <line
              x1={304}
              y1={85}
              x2={304}
              y2={108}
              stroke="currentColor"
              strokeOpacity="0.3"
              strokeDasharray="2 3"
              strokeWidth="1"
            />
            <text
              x={304}
              y={120}
              textAnchor="middle"
              fill="currentColor"
              fillOpacity="0.55"
              fontSize="9"
              fontFamily="Menlo, monospace"
            >
              oracle short-circuit → verdict
            </text>
          </svg>
          <figcaption>
            One linear path on the happy day; alternates fan out from invoke;
            the oracle short-circuits the whole pipeline when an address is
            sanctioned.
          </figcaption>
        </figure>
      </section>

      <section className="docs-section">
        <div className="docs-eyebrow">01 — Surfaces</div>
        <h2>Three ways to talk to it</h2>
        <p>
          Same pipeline behind every surface. The frontend is pure presentation;
          the API and MCP server are peers, not layers.
        </p>

        <h3>Frontend (this page)</h3>
        <p>
          A Vite + React SPA that streams server events from the backend and
          renders them as a live terminal log plus structured cards. No business
          logic lives here — it's a thin window on top of{" "}
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
          The same handler powers the UI, a curl call, or any custom agent. A
          pre-flight budget guard is the first thing it does — if the Agnic
          wallet is too thin to cover the verify run, it bails with a clean{" "}
          <Inline>503 budget_exhausted</Inline>{" "}
          instead of half-paying for services.
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
            <Inline>POST /verify-agent</Inline> — full pipeline, JSON response.
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
          Two tools: <Inline>verify_wallet</Inline> (fast and deep tiers) and
          {" "}
          <Inline>get_deep_verdict</Inline>{" "}
          (run the paid deep check after a fast result asks for one). A
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
          The HTTP transport is bearer-gated. The token is either a self-serve
          API key (<Inline>POST /request-key</Inline>, validated against the DB)
          or the admin{" "}
          <Inline>MCP_SHARED_SECRET</Inline>. With neither a key store nor a
          secret configured, the route returns <Inline>503 mcp_disabled</Inline>
          {" "}
          so you can ship the binary without accidentally exposing the tool.
          Keys are attribution + revocation handles, not paywalls — the service
          is free.
        </p>
      </section>

      <section className="docs-section">
        <div className="docs-eyebrow">02 — Pipeline</div>
        <h2>Discovery → verify</h2>
        <p>
          The work happens in two acts. <em>Discovery</em>{" "}
          finds candidate paid services and picks one per category.{" "}
          <em>Verify</em>{" "}
          pays them in parallel, falls back when they misbehave, and hands the
          evidence to an LLM for synthesis.
        </p>
        <p>
          One honest caveat: the diagram below describes live discovery, which
          is how <Inline>/discover</Inline>{" "}
          and the background vetter still work. The <em>verify</em>{" "}
          hot path no longer re-discovers on every call — it selects from a
          curated, vetted registry (<Inline>src/registry</Inline>){" "}
          the vetter keeps fresh. Same providers, same x402 payments, just off
          the request's critical path so a check doesn't wait on discovery.
        </p>

        <h3>1 · Discover</h3>
        <p>
          Detect the wallet network, fetch candidates per category, rerank with
          an LLM, build a fallback list, and total the estimated cost. The whole
          orchestrator is small on purpose — easy to swap any step in tests.
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
          One search query per requested category, all in flight at once. A
          failed or empty category records an error but never kills the run —
          we'd rather return a partial verdict than nothing.
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
          An LLM picks the best service per category against an ordered list of
          criteria — roughly:
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
          The primary service goes first. If it fails, we walk the alternates
          the discoverer prepared. If the failure looks domain-level (DNS, 404,
          host completely down), we add the host to a blocklist and skip every
          sibling service from the same provider in this run.
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
          Some failures are one-strike-and-out: malformed catalog entries with
          literal <Inline>:endpoint</Inline>{" "}
          placeholders, HTML error pages from non-x402 upstreams, descriptor
          roots with no usable action. Retrying those is wasted USDC, so the
          ranker filters them on every subsequent run until the store is reset.
          Soft quality demotion (empty payloads on rich-history wallets) is
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
          oracle on every supported EVM chain in parallel. If any chain flags
          the address, we short-circuit to a deterministic verdict — zero x402
          spend, instant{" "}
          <Inline>do_not_transact</Inline>. The expensive LLM synthesis only
          runs when the cheap deterministic checks come back clean.
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
        <p>
          After all service data has been collected, everything is passed to
          Claude Opus for a final synthesis — signals are weighed by category,
          and a structured verdict is returned.
        </p>
        <Code lang="typescript">
          {`const PROMPT_PREAMBLE = \`
You are the final judgment layer of a wallet risk-verification agent.
Decide whether it is safe to send money to this wallet.

Signal weights (in order):
  1. sanctions — HARD VETO: any match → do_not_transact, confidence "high"
  2. labels    — STRONG: scam/mixer/exploit words → unsafe; exchange/protocol → safe
  3. onchain_history — SUPPORTING: long active history → positive; new wallet → suspicious
  4. web_sentiment   — SUPPORTING: scam/hack references → negative signal
  5. ens       — CONFIRMATORY: non-null ENS name = doxxed identity, strong positive

Confidence: "high" — sanctions hit or 3+ consistent categories
            "medium" — 3+ categories, mixed but interpretable
            "low" — ≤2 usable signal categories

Return a structured WalletVerdict with verdict, confidence, headline,
reasoning, per-category findings, and coverage.
\`.trim();

export async function synthesizeVerdict(
  input: SynthesisInput,
): Promise<WalletVerdict> {
  const prompt = \`\${PROMPT_PREAMBLE}\\n\\nInput:\\n\${JSON.stringify(input, null, 2)}\`;
  return await llm.generateStructured(WalletVerdictSchema, prompt, {
    model: "anthropic/claude-opus-4.7",
    toolName: "submit_wallet_verdict",
  });
}`}
        </Code>
      </section>

      <section className="docs-section">
        <div className="docs-eyebrow">03 — Result</div>
        <h2>Structured response</h2>
        <p>
          Every surface — JSON endpoint, SSE stream, MCP tool — returns the same
          {" "}
          <Inline>WalletVerdict</Inline>{" "}
          shape. One verdict, one confidence level, per-category findings, full
          coverage accounting, and a USDC receipt.
        </p>
        <Code lang="json">
          {`{
  "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "chain": "eth",
  "safe": true,
  "verdict": "safe_to_transact",
  "confidence": "high",
  "headline": "Safe to transact — publicly doxxed wallet with clean sanctions screen.",
  "reasoning": "The Chainalysis oracle returned no sanctions match on any supported chain. ENS reverse lookup resolved to 'vitalik.eth', indicating a publicly doxxed identity. On-chain history shows 5+ years of activity and thousands of transactions. No negative labels or web-sentiment signals were found.",
  "findings": [
    { "category": "sanctions",       "severity": "info", "finding": "Chainalysis oracle: not sanctioned on any supported chain." },
    { "category": "ens",             "severity": "info", "finding": "ENS name resolved: vitalik.eth — publicly doxxed identity." },
    { "category": "onchain_history", "severity": "info", "finding": "Active since 2016; 10k+ transactions; non-zero balance." },
    { "category": "labels",          "severity": "info", "finding": "No negative labels found." },
    { "category": "web_sentiment",   "severity": "info", "finding": "No scam or exploit references in web results." }
  ],
  "coverage": {
    "requested":  ["sanctions", "labels", "onchain_history", "web_sentiment", "ens"],
    "resolved":   ["sanctions", "labels", "onchain_history", "web_sentiment", "ens"],
    "unresolved": []
  },
  "totalSpentUsdc": 0.043,
  "generatedAt": "2026-05-24T14:32:10.000Z"
}`}
        </Code>
      </section>

      <section className="docs-section">
        <div className="docs-eyebrow">04 — Project</div>
        <h2>Stack &amp; team</h2>

        <h3>Stack</h3>
        <ul className="docs-bullets">
          <li>
            <strong>Runtime:</strong>{" "}
            Deno + Hono on the backend, Vite + React on the frontend.
          </li>
          <li>
            <strong>Payments:</strong>{" "}
            x402 via the Coinbase bazaar, settled in USDC on Base through the
            Agnic gateway.
          </li>
          <li>
            <strong>LLM:</strong>{" "}
            Claude (Opus for synthesis, smaller models for reranking) via the
            Agnic OpenAI-compatible endpoint.
          </li>
          <li>
            <strong>Hosting:</strong>{" "}
            Deno Deploy for the API, Cloudflare Pages for the frontend.
          </li>
          <li>
            <strong>Integrations:</strong>{" "}
            Model Context Protocol SDK for the MCP tool surface.
          </li>
        </ul>

        <h3>Team</h3>
        <div className="docs-team">
          <img
            src="/team/sergiy.jpg"
            alt="Sergiy Fomin"
            className="docs-team-photo"
          />
          <div className="docs-team-bio">
            <strong>Sergiy Fomin</strong>
            <p>
              Toronto-based software engineer who found his way into code
              through business school and a healthy dose of stubborn
              self-teaching. By day I work on cloud infrastructure and
              modernizing legacy systems (GCP, GKE, and the occasional
              expedition into very old codebases). I'm at my best building
              things, breaking them, and figuring out exactly why they broke.
              Off the keyboard, you'll usually find me on my motorcycle, on a
              snowboard, or solo-camping somewhere with no cell signal.
            </p>
          </div>
        </div>
      </section>

      <section className="docs-section">
        <div className="docs-eyebrow">05 — Honest scorecard</div>
        <h2>What's working</h2>
        <ul className="docs-bullets">
          <li>
            <strong>Real payments, real receipts.</strong>{" "}
            The discovery pipeline actually pays for live x402 services and
            surfaces the transaction hashes back to the UI. Nothing simulated.
          </li>
          <li>
            <strong>Graceful degradation.</strong>{" "}
            Per-host blocklisting plus durable + time-windowed health demotion
            means a flaky merchant doesn't poison the run — alternates take over
            and the verdict still ships.
          </li>
          <li>
            <strong>Streaming end-to-end.</strong>{" "}
            Every phase emits SSE events, so the UI and any subscribed agent see
            services start, pay, succeed, or fall back in real time.
          </li>
        </ul>

        <h2>What's not</h2>
        <ul className="docs-bullets">
          <li>
            <strong>Deep-tier latency.</strong>{" "}
            Moving the hot path to a curated registry killed the per-call
            discovery cost, but a deep check still waits on live third-party
            providers and an LLM synthesis hop. It's a few seconds, not
            sub-second. The free fast tier is the instant one.
          </li>
          <li>
            <strong>Coverage depends on the registry.</strong>{" "}
            A deep verdict is only as good as the providers we've vetted in. New
            risk categories mean vetting new services.
          </li>
        </ul>

        <h2>What's next</h2>
        <ul className="docs-bullets">
          <li>
            Keep it free and shared. Every deep check is paid out of pocket;
            while that's cheap, anyone can use it.
          </li>
          <li>
            Collect feedback from the dev and crypto communities — what's
            useful, what's missing — and write up the interesting parts on the
            blog.
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
