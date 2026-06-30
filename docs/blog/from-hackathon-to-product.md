---
title: From hackathon to product
slug: from-hackathon-to-product
excerpt: "My first real crack at agentic development — what worked, where it cracked, and what still needs a human in the loop. Notes from building WARD-o."
published_at: 2026-06-30
---

*Notes from building WARD-o — a free wallet risk check for agents that spend
money — mostly through an AI coding agent.*

This is the first post here, so it's a fair place to be honest about how the
thing got built. Ward-o started as a [hackathon project](https://pioneers.agnic.ai/demo-day)
— it took 10 days to build, was presented during Toronto Tech Week, and ended up
winning its ["agents you can trust"](https://www.linkedin.com/posts/agnic_simoneai-wardo-easypace-activity-7466646454011318272-ICB0/)
track. It was also my first real crack at agentic development, and I want to
share that experience: **what worked, where it started to crack, and what still
needs a human in the loop.**

## Greenfield was a breeze

The first version came together absurdly fast. The loop was: write a plan ticket
— acceptance criteria, validation commands, a test spec — hand it to the agent,
review the diff, ship. Feature dev, the React UI, the Deno backend, deployment
and hosting on Cloudflare Pages: all of it moved at a pace that still feels
unreasonable. On a clean codebase with no real constraints,
plan-ticket-to-execution is genuinely close to magic. If your project is
green-field, the current generation of coding agents will not be your bottleneck.

## Then I added a database

The cracks showed up the moment performance optimization started leaning on
**infrastructure** instead of pure application code.

The hackathon build re-ran live service discovery on every request — correct, but
slow and expensive. The fix was a stack of infra: a curated Postgres registry on
Neon to replace live discovery on the hot path, a KV verdict cache, a scoring +
status machine to rank services, and a background cron that probes for price
drift every 12 hours. Ten tickets in a few days.

Each ticket, in isolation, the agent handled fine. The problem is that infra
multiplies the *surfaces* — routes, migrations, an online DB path, an offline
fallback path, a job schedule — and the agent (like a human) only sees the slice
in front of it.

Here's the bug that made it concrete. The hot path quietly collapsed to **"0
active services."** Root cause: the scoring query counted service observations
where `status = 'success'` — but the writer only ever recorded `'ok'` or
`'error'`. Two bare string literals, in two different files, that had silently
drifted apart. So every service computed `0 / total` reliability, got demoted
active → probation → blocked in a single recompute, and selection fell back to a
handful of hardcoded recipes — which were now also blocked. A one-word mismatch
took the whole engine down, and nothing threw. The fallback path *worked*, which
is exactly why it was dangerous.

This is the honest center of the story: agents are great at writing the code in
front of them and bad — as bad as we are — at holding an invariant that spans a
DB writer, a scorer, and a fallback nobody looks at until it fires.

## The fix was a guardrail, not a patch

The cheap fix was to change one string. The real fix was to make that class of
bug **impossible to write again**: centralize the status values into a single
`enums.ts` so `'ok'` vs `'success'` drift becomes a compile error, not a silent
service degradation I end up investigating.

That instinct generalized into the most useful thing I did all month:
**centralizing the harness.** The repo's `CLAUDE.md` grew into a dense list of
do's and don'ts — when re-recording paid test cassettes is required versus
forbidden, hard rules for isolating parallel agents in separate git worktrees,
database conventions (one client, no-op when unconfigured, row types kept
column-for-column with the SQL). Most of those rules are scar tissue from a
specific failure. The lesson: with agents, your guardrails *are* your
architecture. Constraints that live in one well-known place are what keep the
next agent — or the next me — from silently reintroducing the bug you just fixed.

## Shipping got easy. Knowing what to ship didn't.

When the demo became "a product," the hard part wasn't engineering. It was the
pivot itself: dropping "in seconds" from the copy because the deep check honestly
isn't instant, deciding there'd be no paid tier, reframing what the thing even
*is*. None of that is a coding problem. Figuring out market fit, how this compares
to what already exists, and how to position it is still squarely a human domain —
at least in my experience. Agents made it dramatically cheaper to *build* the
product and did nothing to tell me whether it was the right product.

## What actually kept it honest: staying in the loop

The single highest-leverage thing was wiring the agent to **verify against the
real system** — invoke the live service, drive the actual UI, read the real
database — instead of trusting that the diff matched the spec. That takes setup:
MCP tools so the agent can call the deployed verifier and inspect prod data, an
offline cassette suite so tests stay free and deterministic, a preview harness for
the frontend. But once the agent can *observe consequences*, its output gets
honest. It stops reporting "done" and starts reporting "done, and here's the
verdict it returned."

My one-line takeaway: **longer in the loop is better.** More verification — more
of the agent's work spent checking reality rather than producing more code — gave
me a measurably better system. The wins weren't from a cleverer prompt; they were
from closing the loop between *write* and *observe*.

## Where that leaves me

Agentic development collapsed the cost of building features and testing them. But
to me, orchestrating and validating the work — making sure the system doesn't
drift somewhere I didn't want it to go — is the real job now. I can't say I'm
overly excited about not writing code directly. I do appreciate having this kind
of tool available to make the product — the final outcome of engineering — come
to life faster.
