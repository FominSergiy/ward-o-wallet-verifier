# adapter-descriptor-retry

**What:** When a successful pattern-adapter call returns a service-descriptor
payload (`{endpoints: string[]}`) instead of address data, the invoker now
retries once against the first non-info action sub-endpoint and records the
outcome as `adapterPath: "pattern+subpath"`. Fixes a long-standing bug where
v6 was paying for orbisapi services and receiving API metadata instead of
labels/reputation data — the catalog publishes only the descriptor URL while
the real action endpoint lives one level deeper (e.g. `/label`, `/score`).

**Files:**

- `src/discovery/adapter.ts` — added `isServiceDescriptor(data)` (detects
  `{endpoints: string[]}` shape, guards against false positives by rejecting
  any payload with a top-level `address`/`wallet`/`addr`/`account` key) and
  `pickActionEndpoint(endpoints, category?)` (skips info paths
  `/openapi|/docs|/health|/`; for known categories prefers endpoints whose
  path contains a category-aligned token).
- `src/agent/invoke_service.ts` — extended `ServiceInvocationOutcome.adapterPath`
  to include `"pattern+subpath"`; new `handleDescriptorResponse()` retries once
  against the picked sub-endpoint (preserves POST body, preserves any existing
  query string via `appendSubPath()`), records the retry's outcome, and does
  NOT fall through to the LLM adapter (LLM is forbidden from inventing path
  segments and would be rebuilding the same descriptor URL). New `errorCode`
  `descriptor_only_response` is emitted when no action endpoint can be picked
  or the retry also returns a descriptor.
- `src/discovery/adapter_test.ts` — 13 new tests covering helper semantics
  (descriptor detection edge cases, address-key guard, category-token
  preferences including a real orbisapi reputation fixture).
- `src/agent/invoke_service_test.ts` — 7 new tests covering the end-to-end
  retry: success path, info-only descriptor → error, recursive descriptor →
  error, sub-path retry failure code propagation, POST body preservation,
  `appendSubPath` query/slash handling.

**Config:** No new env vars. Cost trade-off: when a descriptor is returned,
we pay for one additional sub-path call (~$0.005 per orbisapi service per
verify). On the 4-wallet validation panel this added $0.0048 per wallet on
average and recovered the labels + reputation data the synthesizer was
previously missing.

**Category-token table:**

- `labels` → `[label, tag, entity, score, risk, reputation]` (the labels
  category in this app is broad — it covers both name-labelers like orbisapi
  `crypto-address-labeler` (`/label`) and reputation/risk scorers like
  orbisapi `address-reputation-score` (`/score`), because the Category enum
  has no separate `risk` value. Score/risk/reputation tokens are listed last
  so a true labeler is preferred when both endpoints exist.)
- `web_sentiment` → `[sentiment, social]`.
- `sanctions` → `[sanctions, screen, ofac]`.
- Other categories fall back to first non-info endpoint.

**Notes:**

- *No catalog hint exists.* Confirmed during planning: `extensions.bazaar.info.input`
  for the two known orbisapi services contains no `pathParams` or other field
  pointing at the action sub-path. The fix had to be a runtime heuristic; a
  catalog-side fix would require provider cooperation.
- *Why not the LLM adapter?* `buildCallFromInfoViaLlm` is intentionally
  constrained by a post-LLM URL validator
  (`src/discovery/adapter.ts:246–250, 278`) that rewrites away any path
  drift. It cannot legally produce a `/label` segment that isn't already in
  `service.resource`. Adding "LLM picks sub-path from descriptor" would
  require a separate prompt + separate validator + a way to feed in runtime
  descriptor evidence — a different feature shape, and one that risks silent
  miscategorization (LLM picks `/score` on a labels service → synthesizer
  reads risk numbers as labels). Reserved for a follow-up if a service emerges
  where the category-token picker chooses wrong.
- *Provider data quality is still sparse.* Even with the fix, orbisapi
  `crypto-address-labeler-api-79be80` returns `known_label: null,
  is_known: false` for Vitalik, Binance HW20, and Lazarus. The fix unblocks
  the response *shape*, not the *data quality*. A separate catalog audit
  (PR2 in the original brief) is needed to identify better label providers.
- *`/score` returned `unauthorized` in the standalone probe script* during
  validation, but worked correctly via the `verify-agent` flow — suggests an
  auth header that the pipeline sets but the standalone probe doesn't.
  Not load-bearing for this change.
- *Catalog audit (PR2) deferred to a separate branch* per the original brief.

**Validation:**

- `~/.deno/bin/deno task check` / `lint` / `test` — all green (49 tests in
  `adapter_test.ts` + `invoke_service_test.ts`; 176 total project tests).
- `scripts/test_wallets.ts` against the 4 known wallets — 4/4 verdicts match
  (Vitalik, Binance HW20 → `safe_to_transact`; Lazarus, Tornado →
  `do_not_transact`); both orbisapi services show 100% success with
  `adapterPath: "pattern+subpath"` in receipts; synthesizer reasoning now
  cites label findings substantively ("labels came back as unknown (neutral,
  not negative)", "no known label") instead of the prior "only API metadata"
  complaint.
