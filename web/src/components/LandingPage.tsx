import { type MouseEvent, useState } from "react";
import { navigate } from "../router";
import { CodeBlock } from "./CodeBlock";
import { type IssuedKeyResponse, requestApiKey } from "../api";
import { API_BASE, BUYMEACOFFEE_URL } from "../config";

const apiUrl = API_BASE || "https://<your-ward-o-api>";

function goVerify(e: MouseEvent<HTMLAnchorElement>) {
  e.preventDefault();
  navigate("/verify");
}

// Section 3's interactive bit: mint a key in the browser and show it once.
function KeyGenerator() {
  const [key, setKey] = useState<IssuedKeyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    setErr(null);
    setCopied(false);
    try {
      setKey(await requestApiKey("web-self-serve"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key.apiKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="keygen">
      <button className="deep-check-btn" onClick={generate} disabled={busy}>
        {busy ? "Minting…" : key ? "Generate another" : "Generate my key"}
      </button>
      {err && <p className="hint">Couldn’t mint a key: {err}</p>}
      {key && (
        <div className="keybox">
          <code className="keybox-token">{key.apiKey}</code>
          <button className="keybox-copy" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
          <p className="keybox-note">{key.note}</p>
        </div>
      )}
    </div>
  );
}

export function LandingPage() {
  return (
    <article className="docs landing">
      <header className="landing-hero">
        <h1>Wallet risk checks for agents that spend money.</h1>
        <p className="landing-lede">
          Hand WARD-o an EVM address and it tells your agent whether the wallet
          is safe to pay. The sanctions screen is free and instant; the deep
          check digs further for a few cents. Free to use — no signup for the
          web app.
        </p>
        <div className="landing-cta">
          <a className="cta-primary" href="/verify" onClick={goVerify}>
            Try the verifier →
          </a>
          <a className="cta-secondary" href="#mcp">Set up the MCP server ↓</a>
        </div>
      </header>

      {/* 1 — Overview */}
      <section className="docs-section">
        <div className="docs-eyebrow">00 — What it is</div>
        <h2>One question: is this wallet safe to pay?</h2>
        <p>
          You give WARD-o a wallet address; it returns a structured verdict your
          agent can act on —{" "}
          <code className="docs-inline">safe_to_transact</code>,{" "}
          <code className="docs-inline">do_not_transact</code>, or{" "}
          <code className="docs-inline">insufficient_data</code>{" "}
          — with the reasoning and on-chain receipts behind it. It runs in two
          tiers:
        </p>
        <ul className="docs-bullets">
          <li>
            <strong>Fast — free, instant, $0.</strong>{" "}
            A sanctions gate (a local denylist plus the Chainalysis on-chain
            oracle across every supported chain). An OFAC-sanctioned address
            comes back <code className="docs-inline">do_not_transact</code>{" "}
            in under a second, with no spend.
          </li>
          <li>
            <strong>Deep — a few cents, slower.</strong>{" "}
            Pulls entity labels, on-chain history, web sentiment and ENS — some
            from paid providers over the x402 protocol, some from free chain
            primitives — and has an LLM weigh it all into the final verdict.
          </li>
        </ul>
        <p>
          Pick the tier you need: the fast tier is free and immediate; the deep
          tier takes longer — it makes live calls to third-party data sources
          and a language model — but gives a stronger signal.
        </p>
      </section>

      {/* 2 — How to use it */}
      <section className="docs-section">
        <div className="docs-eyebrow">01 — Two ways in</div>
        <h2>Use the web app, or wire it into your agent</h2>
        <h3>The web app</h3>
        <p>
          Open the{" "}
          <a href="/verify" onClick={goVerify}>verifier</a>, paste an address,
          and hit <strong>Fast Check</strong> (free) or{" "}
          <strong>Deep Check</strong>. You’ll see every step stream in live —
          which sources are queried, what they cost, and the final verdict.
        </p>
        <h3>Your agent, over MCP</h3>
        <p>
          WARD-o ships as an{" "}
          <a
            href="https://modelcontextprotocol.io"
            target="_blank"
            rel="noopener noreferrer"
          >
            MCP
          </a>{" "}
          server with one tool,{" "}
          <code className="docs-inline">verify_wallet</code>{" "}
          (fast and deep tiers). Drop it into Claude Desktop, Cline, or any MCP
          client and your agent can check a wallet before it sends a payment.
          The MCP path needs a key — grab one below. (Prefer raw HTTP? The same
          pipeline is a <code className="docs-inline">POST /verify-agent</code>
          {" "}
          call — see the{" "}
          <a
            href="/docs"
            onClick={(e) => {
              e.preventDefault();
              navigate("/docs");
            }}
          >
            architecture page
          </a>.)
        </p>
      </section>

      {/* 3 — MCP setup */}
      <section className="docs-section" id="mcp">
        <div className="docs-eyebrow">02 — Set up the MCP server</div>
        <h2>Get a key, add the server</h2>
        <p>
          <strong>1. Get a key.</strong>{" "}
          One request, no account. Click below, or run the curl:
        </p>
        <KeyGenerator />
        <CodeBlock lang="bash">
          {`curl -X POST ${apiUrl}/request-key
# → { "apiKey": "wardo_sk_…", "prefix": "wardo_sk_…", "note": "shown once" }`}
        </CodeBlock>
        <p>
          <strong>2. Add WARD-o to your MCP client</strong>{" "}
          over Streamable HTTP, passing the key as a Bearer token:
        </p>
        <CodeBlock lang="json">
          {`{
  "mcpServers": {
    "ward-o": {
      "url": "${apiUrl}/mcp",
      "headers": { "Authorization": "Bearer wardo_sk_…" }
    }
  }
}`}
        </CodeBlock>
        <p>
          That’s it — your agent now has{" "}
          <code className="docs-inline">verify_wallet</code>. The key is an
          attribution + rate-control handle, not a paywall: WARD-o is free, and
          the key just lets us see usage and cut off abuse if it ever shows up.
        </p>
      </section>

      {/* 4 — Architecture */}
      <section className="docs-section">
        <div className="docs-eyebrow">03 — How it works</div>
        <h2>Sanctions gate first, then a paid deep dive</h2>
        <div className="pipeline">
          <span className="pipeline-step">address</span>
          <span className="pipeline-arrow">→</span>
          <span className="pipeline-step">sanctions gate (free)</span>
          <span className="pipeline-arrow">→</span>
          <span className="pipeline-step">risk sources ∥ chain primitives</span>
          <span className="pipeline-arrow">→</span>
          <span className="pipeline-step">LLM synthesis</span>
          <span className="pipeline-arrow">→</span>
          <span className="pipeline-step">verdict</span>
        </div>
        <p>
          Every check starts with the free sanctions gate. If the address is
          sanctioned, WARD-o short-circuits to{" "}
          <code className="docs-inline">do_not_transact</code>{" "}
          with zero spend. Otherwise the deep check selects vetted risk
          providers from a curated registry, invokes them in parallel (paying
          per call in USDC over x402), and reads free chain primitives — ENS,
          label registries, the oracle — alongside. A flaky provider doesn’t
          sink the run: WARD-o falls back to an alternate and ships a partial
          verdict rather than nothing. Finally Claude weighs the evidence by
          category into a structured verdict.
        </p>
        <p>
          <a
            href="/docs"
            onClick={(e) => {
              e.preventDefault();
              navigate("/docs");
            }}
          >
            Read the full architecture write-up →
          </a>
        </p>
      </section>

      {/* 5 — Buy me a coffee */}
      <section className="docs-section">
        <div className="docs-eyebrow">04 — Keep it free</div>
        <h2>Paid in kind</h2>
        <p>
          WARD-o is free to use. Every deep check spends real USDC from my own
          wallet — I cover it because it’s cheap and I’d rather share it than
          gate it. There’s no plan, no invoice, no upsell. If it saves you from
          paying a scammer or just from an afternoon on Etherscan, you can buy
          me a coffee — purely in kind.
        </p>
        <a
          className="coffee-btn"
          href={BUYMEACOFFEE_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          ☕ Buy me a coffee
        </a>
      </section>
    </article>
  );
}
