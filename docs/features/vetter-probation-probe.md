# vetter-probation-probe

**What:** An opt-in phase in the twice-daily Background Vetter that pays-and-invokes
`probation` service candidates against the wallet fixtures so they accrue real
`service_observations`, letting the existing scorer promote (or block) them —
fixing a starvation loop where probation candidates got ~zero organic traffic and
could never earn promotion.

## Why

Selection makes the top-ranked service the *primary* and puts probation rows in
the *cold fallback* tier (invoked only when the primary errors —
`src/registry/select.ts`). Healthy primaries rarely fail, so probation candidates
received almost no traffic and never reached the ~11 successful observations that
`recomputeScores` needs to promote at reliability ≥ 0.80 (pessimistic 1/4 prior).
Observed in prod: 43 probation / 29 blocked / 2 active, with 39/43 probation rows
at 0 observations over 30 days. This phase supplies the missing evidence without
lowering the promotion bar.

## Files

- `src/vetter/probe.ts` (new) — `probeProbationCandidates(opts)`: balance-floor
  preflight, cheapest+least-recently-vetted ordering, price cap, per-run spend
  ceiling, per-fixture invocation via `invokeAll` (which already writes the
  observation). Returns `{ probed, skipped, spendUsdc, belowFloor, observations }`.
- `src/vetter/run.ts` — new phase between discovery and recompute (gated by budget
  > 0); env-config reader; `runProbe` seam; `VetterResult.probeResult`.
- `src/vetter/probe_test.ts` (new) — 9 seamed unit tests (budget-0 no-op, floor
  skip, null-balance proceeds, price cap, cheapest-first, ceiling stop, obs
  counting, sanctions-throw caught, denied host).
- `src/vetter/run_test.ts` — 2 tests (unfunded no-op + surfaced empty result;
  discovery→probe→recompute ordering).
- `scripts/vet.ts` — probe summary line.
- `.github/workflows/vetter.yml` — probe env vars wired from repo `vars.*`.
- `.env.example` — documents the four vars.

## Config

All optional; the phase is a no-op unless funded.

| Var | Default | Meaning |
| --- | --- | --- |
| `VETTER_PROBE_BUDGET_USDC` | `0` (disabled) | Per-run spend ceiling. Recommended `0.25`. Max daily = 2 runs × this. |
| `VETTER_PROBE_MIN_BALANCE_USDC` | `0` (off) | Skip the phase if Agnic balance is below this reserve. |
| `VETTER_PROBE_MAX_PRICE_USDC` | `0.10` | Skip candidates dearer than this (never auto-probe the $1.50–2.50 labelers). |
| `VETTER_PROBE_FIXTURES` | `3` | Fixtures probed per candidate per run. |

Requires USDC balance on `AGNIC_API_KEY`. On GitHub, set the values as repo
**variables** (not secrets) so the workflow's `${{ vars.* }}` picks them up.

## Notes

- **Spends real USDC when enabled.** Ceiling is a hard per-run cap (the loop won't
  *start* a candidate that would exceed it); floor protects a reserve. Both must
  be considered before turning it on.
- `invokeAll` throws `SanctionsInvocationError` on a sanctions-category failure,
  but *after* recording the observation — the probe catches it, counts the obs,
  and continues. Viem fallback is disabled so only the candidate's own outcome is
  recorded.
- No cassette re-record needed: this touches the vetter only; the `verifyAgent`
  replay pipeline's recorded HTTP traffic is unchanged.
- Promotion/scoring logic (`src/registry/score.ts`) is unchanged — it was starved
  of input, not miscalibrated.
- **Follow-up:** first enablement should be smoke-tested against a Neon dev branch
  (`VETTER_PROBE_BUDGET_USDC=0.05 deno run … scripts/vet.ts`) before setting the
  workflow variables on prod. The 29 blocked rows are a separate audit.
