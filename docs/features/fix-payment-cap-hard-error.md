# fix-payment-cap-hard-error

**What:** Treats the entire payment-cap error family as a HARD error so a
price-drift / cap rejection no longer wastes an LLM-fallback build + retry call.

## Files

- `src/agent/invoke_service.ts` — removed the dead `payment_exceeds_max` literal
  from `HARD_ERROR_CODES` and added `isPaymentCapError(code)` (prefix match on
  `payment_exceeds`), checked in `isUpstreamInputError`. agnicFetch normalizes
  upstream messages (`rawCode.toLowerCase().replace(/[\s-]+/g,"_")`), so the same
  cap rejection surfaces as `payment_exceeds_max` /
  `payment_exceeds_maximum_allowed_value` / etc. — the old exact-string entry
  never matched the normalized form, so cap errors fell through to the LLM
  fallback. The prefix match catches the whole family.
- `src/agent/invoke_service_test.ts` — new test: a `402 "Payment exceeds
  maximum allowed value"` upstream error yields an immediate `error` outcome
  with `adapterPath:"pattern"`, **zero LLM calls**, and a single network call.
- `tests/cassettes/*.json` — trimmed the now-dead recorded interactions (see
  Notes). 7 wallets each lost 2 entries (the fallback-build LLM call + the retry
  cap call); the 2 oracle-short-circuit wallets were untouched.

## Config

None.

## Notes

- **This was the deferred follow-up** flagged in #76's `invoke_service.ts`
  "KNOWN GAP" comment ("needs a cassette re-record").
- **Why the cassettes changed without a paid re-record.** The replay interceptor
  is FIFO keyed on `METHOD:URL` only. All LLM calls share `/v1/chat/completions`,
  so dropping the fallback-build LLM call shifted the queue and synthesis began
  consuming the fallback's recorded response → wrong verdict. Rather than run the
  paid `cassette:record` (which also wasn't possible here — `AGNIC_API_KEY` is
  absent from `.env`), the dead interactions were removed surgically: for each
  recorded cap pair `[primary, retry]`, the new code makes only the primary call,
  so the retry cap entry and the single fallback-build LLM entry between the pair
  were deleted (script in scratchpad; deterministic, asserts exactly one LLM per
  cap pair). This is the faithful equivalent of what a re-record would capture
  for this delta — **every per-wallet verdict assertion stayed green and
  unchanged**, which is the regression guard.
- **Verdict impact: none.** A cap error left the category unresolved before (via
  "both adapters failed") and leaves it unresolved now (single adapter fails) —
  the fix only removes a wasted LLM call + retry, it doesn't change any verdict.
- Validation: 392 offline tests pass (+1), replay 9/9, `deno task check` +
  `deno task lint` clean.
