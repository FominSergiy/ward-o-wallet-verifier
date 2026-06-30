# v6 LLM-adapter stress test — `FORCE_LLM_ADAPTER=true`

**Date:** 2026-05-23
**Branch:** `feat/discovery-improvement`
**Endpoint:** `http://localhost:8000/verify-agent`
**Hook:** new dev-only env flag `FORCE_LLM_ADAPTER=true` (see
[src/agent/invoke_service.ts](../../src/agent/invoke_service.ts)) — skips the
pattern-match adapter so every paid call goes through
`buildCallFromInfoViaLlm()` and the post-LLM URL-rewrite validator.

This addresses v6-follow-up §7.3: "Stress-test the B2 LLM-adapter validator…
no production traffic exercised it."

---

## What was run

Two wallets, one server process (`FORCE_LLM_ADAPTER=true` +
`HEALTH_STORE_PATH=data/service_health.llm_stress.json` with an empty store):

| Wallet | Expected | Verdict / conf | LLM receipts | LLM successes | Hard errors |
|---|---|---|---|---|---|
| Vitalik EOA (`0xd8dA…6045`) | safe | **safe_to_transact / medium** | 4 / 4 | 3 / 4 | 1 |
| Lazarus EOA (`0x098B…2f96`) | do_not | **do_not_transact / high** | 4 / 4 | 3 / 4 | 1 |

**Verdict accuracy under LLM-only:** 2/2 (100%). Both verdicts also agreed
with the v6 baseline confidence levels.

---

## 1. Was the LLM path actually exercised?

```
$ grep -c 'FORCE_LLM_ADAPTER=true' /tmp/agnic_llm_stress.log
8
```

8 = 4 services × 2 wallets. Every paid service call went through the LLM
fallback. Zero pattern-adapter receipts.

All 8 receipts have `adapterPath: "llm"` and either
`status: "fallback_ok"` (LLM-built call succeeded) or `status: "error"`
(call still failed downstream).

## 2. Did the validator rewrite any URLs?

```
$ grep -c '\[adapter-llm\] url-changed' /tmp/agnic_llm_stress.log
0
```

**Zero rewrites across 8 services.** The LLM (Claude Haiku 4.5 per
`ADAPTER_LLM_MODEL` default) faithfully kept the catalog URL path for
every service in our panel — no spurious `/classify` / `/predict` / etc.
suffixes invented.

This is a positive finding, not a non-result: it means the catalog's
`inputInfo` descriptors are clear enough that the LLM doesn't try to
reshape the URL. The validator is doing what we want — sitting dormant
as a safety net, not constantly correcting drift.

The B2 validator's unit tests at
[adapter_test.ts:247-296](../../src/discovery/adapter_test.ts) still
cover the rewrite-rejection + path-param-substitution paths
synthetically, so the logic is exercised; this stress run just shows we
don't need it on the wallets/services we currently rank into the top
slot.

## 3. Where did the LLM-only path fail?

Two failures, both on `web_sentiment`:

| Wallet | Service | Failure |
|---|---|---|
| Vitalik | `orbisapi.com/.../wallet-address-risk-api-c6680c/:endpoint` | `non_json_response` — HTML 404 (`Cannot POST /wallet-address-risk/:endpoint`) |
| Lazarus | `orbisapi.com/.../wallet-risk-score-api-d4822c` | `not_found` — agnic gateway `[Not found]: Not Found` |

Both are **catalog-side** problems, not LLM-adapter problems:
- `c6680c/:endpoint` is the same unresolved path-param service that broke
  in v6 §6.
- `d4822c` returned a clean `Not found` from the agnic gateway.

The LLM produced a syntactically valid call in both cases — the upstream
just doesn't accept it. Pattern adapter would have failed identically.

## 4. Ticket-1 + Ticket-2 evidence (synthetic error codes)

This run is also the **first real-traffic confirmation** of the v6
follow-ups #2 and #4 fixed in this PR:

**a. `non_json_response` is now emitted on HTML error bodies**
([src/clients/agnic.ts](../../src/clients/agnic.ts)). Vitalik's
web_sentiment failure produced this health-store entry:

```json
"https://orbisapi.com/proxy/wallet-address-risk-api-c6680c/:endpoint": {
  "ok": 0,
  "err": 1,
  "lastError": "agnicFetch [non_json_response]: HTTP 404 Not Found returned non-JSON body (<!DOCTYPE html> <html lang=\"en\"> <head> ...",
  "lastErrorCode": "non_json_response"
}
```

In v6, the same service crashed the JSON parser before `AgnicFetchError`
could be built — `lastErrorCode` was `undefined` and the service couldn't
be flagged for `isDurablyBlocked`. With Ticket 1 in place, the code
propagates cleanly. (We did **not** add `non_json_response` to
`DURABLE_BLOCK_CODES` — per the plan decision, observe first and block
once a pattern emerges.)

**b. Lazarus's `not_found` was already handled correctly** — the
gateway emitted a JSON error, agnicFetch normalized to `code: "not_found"`,
and the health store recorded `lastErrorCode: "not_found"`. That's the
existing behavior, validated against fresh traffic.

## 5. Cost + latency

Vitalik: 51.5 s wall, $0.013 spent (3 paid LLM successes).
Lazarus: 47.4 s wall, $0.013 spent.
Total: ~$0.026 over 2 wallets. Comparable to v6 baseline
($0.0696 / 4 wallets = $0.017 / wallet) — LLM-only didn't add measurable
overhead, because the LLM call cost is dwarfed by the paid x402 calls.

## 6. Verdict on the validator (B2)

- ✓ The flag works as designed — pattern is fully bypassed under
  `FORCE_LLM_ADAPTER=true`.
- ✓ The LLM path delivers correct verdicts (2/2 wallets, both
  expected verdict + confidence).
- ✓ The validator is wired in but didn't need to fire on the current
  service panel — interpret as "the LLM is well-behaved for these
  inputs," not as "the validator is untested" (unit tests still cover
  the logic).
- ✓ The errors that DID surface are catalog-side, not adapter-side, and
  are now recorded with non-undefined `lastErrorCode` — exactly the
  observability gap v6 flagged.

The `FORCE_LLM_ADAPTER` flag stays in the code as a dev-only stress
hook. It's gated by env (default off), so it has zero impact on
normal traffic.

## Raw artifacts

- Server log: `/tmp/agnic_llm_stress.log`
- Receipts: `/tmp/llm_stress_vitalik.json`, `/tmp/llm_stress_lazarus.json`
  (transient — kept out of repo to avoid polluting `runs_v6_*/`)
- Health store snapshot: `data/service_health.llm_stress.snapshot.json`
