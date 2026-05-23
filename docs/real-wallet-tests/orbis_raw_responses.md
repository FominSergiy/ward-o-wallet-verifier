# Orbisapi raw response inspection

**Date:** 2026-05-23T13:35:37.760Z

Captures of the two orbisapi services that v6 verdicts characterized as "Label/Reputation provider returned only API metadata; no risk or safety labels are attached to this address."

The goal: determine whether (a) the provider genuinely returns thin data on these test addresses (provider gap), or (b) the synthesizer is under-reading a populated field (extraction gap we can fix).

## labels (crypto-address-labeler-api-79be80)

- URL pattern: `https://orbisapi.com/proxy/crypto-address-labeler-api-79be80?address=…`
- Method: GET

### Vitalik EOA (`0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`)

*ENS-doxxed, no negative attribution expected*

Paid: `true`, Amount: `$0.0050`

**Field inventory:**
```
name: string = Crypto Address Labeler API
endpoints: array(2)
docs: string = /openapi
```

**Raw response:**
```json
{
  "name": "Crypto Address Labeler API",
  "endpoints": [
    "/label",
    "/openapi"
  ],
  "docs": "/openapi"
}
```

### Binance HW20 (`0xf977814e90da44bfa03b6295a0616a897441acec`)

*Major institutional cold wallet — should surface 'Binance' label if provider knows it*

Paid: `true`, Amount: `$0.0050`

**Field inventory:**
```
name: string = Crypto Address Labeler API
endpoints: array(2)
docs: string = /openapi
```

**Raw response:**
```json
{
  "name": "Crypto Address Labeler API",
  "endpoints": [
    "/label",
    "/openapi"
  ],
  "docs": "/openapi"
}
```

### Lazarus EOA (`0x098B716B8Aaf21512996dC57EB0615e2383E2f96`)

*OFAC-sanctioned — should surface SDN / sanctions tag if provider knows it*

Paid: `true`, Amount: `$0.0050`

**Field inventory:**
```
name: string = Crypto Address Labeler API
endpoints: array(2)
docs: string = /openapi
```

**Raw response:**
```json
{
  "name": "Crypto Address Labeler API",
  "endpoints": [
    "/label",
    "/openapi"
  ],
  "docs": "/openapi"
}
```

## reputation (address-reputation-score-api-9d7eb2)

- URL pattern: `https://orbisapi.com/proxy/address-reputation-score-api-9d7eb2?address=…`
- Method: GET

### Vitalik EOA (`0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`)

*ENS-doxxed, no negative attribution expected*

Paid: `true`, Amount: `$0.0075`

**Field inventory:**
```
name: string = Address Reputation Score API
description: string = Risk score 0-100 for any wallet address before sending USDC.…
endpoints: array(11)
version: string = 1.0.0
```

**Raw response:**
```json
{
  "name": "Address Reputation Score API",
  "description": "Risk score 0-100 for any wallet address before sending USDC. Checks OFAC sanctions, scam reports, mixer proximity, and on-chain behavior heuristics.",
  "endpoints": [
    "/",
    "/info",
    "/validate",
    "/parse",
    "/score",
    "/bulk",
    "/classify",
    "/describe",
    "/compare",
    "/analyze",
    "/format"
  ],
  "version": "1.0.0"
}
```

### Binance HW20 (`0xf977814e90da44bfa03b6295a0616a897441acec`)

*Major institutional cold wallet — should surface 'Binance' label if provider knows it*

Paid: `true`, Amount: `$0.0075`

**Field inventory:**
```
name: string = Address Reputation Score API
description: string = Risk score 0-100 for any wallet address before sending USDC.…
endpoints: array(11)
version: string = 1.0.0
```

**Raw response:**
```json
{
  "name": "Address Reputation Score API",
  "description": "Risk score 0-100 for any wallet address before sending USDC. Checks OFAC sanctions, scam reports, mixer proximity, and on-chain behavior heuristics.",
  "endpoints": [
    "/",
    "/info",
    "/validate",
    "/parse",
    "/score",
    "/bulk",
    "/classify",
    "/describe",
    "/compare",
    "/analyze",
    "/format"
  ],
  "version": "1.0.0"
}
```

### Lazarus EOA (`0x098B716B8Aaf21512996dC57EB0615e2383E2f96`)

*OFAC-sanctioned — should surface SDN / sanctions tag if provider knows it*

Paid: `true`, Amount: `$0.0075`

**Field inventory:**
```
name: string = Address Reputation Score API
description: string = Risk score 0-100 for any wallet address before sending USDC.…
endpoints: array(11)
version: string = 1.0.0
```

**Raw response:**
```json
{
  "name": "Address Reputation Score API",
  "description": "Risk score 0-100 for any wallet address before sending USDC. Checks OFAC sanctions, scam reports, mixer proximity, and on-chain behavior heuristics.",
  "endpoints": [
    "/",
    "/info",
    "/validate",
    "/parse",
    "/score",
    "/bulk",
    "/classify",
    "/describe",
    "/compare",
    "/analyze",
    "/format"
  ],
  "version": "1.0.0"
}
```

---

## Pass 2 — Sub-endpoint probes

Pass 1 returned identical responses across all 3 wallets for both services — the response is the service descriptor (a list of available sub-endpoints), NOT label or score data. Below: probe the documented sub-paths to see if address data lives one level deeper.

### labels → /label sub-endpoint

URL: `https://orbisapi.com/proxy/crypto-address-labeler-api-79be80/label?address=…`

#### Vitalik EOA (`0xd8dA6BF2…`)

Paid: `true`, Amount: `$0.0050`

```json
{
  "address": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
  "known_label": null,
  "entity_type": "unknown",
  "risk_level": "unknown",
  "is_known": false,
  "patterns": {
    "is_burn": false,
    "is_evm": true
  },
  "note": "Check Etherscan or Arkham for on-chain analysis",
  "source": "Address Labeler"
}
```

#### Binance HW20 (`0xf977814e…`)

Paid: `true`, Amount: `$0.0050`

```json
{
  "address": "0xf977814e90da44bfa03b6295a0616a897441acec",
  "known_label": null,
  "entity_type": "unknown",
  "risk_level": "unknown",
  "is_known": false,
  "patterns": {
    "is_burn": false,
    "is_evm": true
  },
  "note": "Check Etherscan or Arkham for on-chain analysis",
  "source": "Address Labeler"
}
```

#### Lazarus EOA (`0x098B716B…`)

Paid: `true`, Amount: `$0.0050`

```json
{
  "address": "0x098b716b8aaf21512996dc57eb0615e2383e2f96",
  "known_label": null,
  "entity_type": "unknown",
  "risk_level": "unknown",
  "is_known": false,
  "patterns": {
    "is_burn": false,
    "is_evm": true
  },
  "note": "Check Etherscan or Arkham for on-chain analysis",
  "source": "Address Labeler"
}
```

### reputation → /score sub-endpoint

URL: `https://orbisapi.com/proxy/address-reputation-score-api-9d7eb2/score?address=…`

#### Vitalik EOA (`0xd8dA6BF2…`)

**FAILED** — code: `unauthorized`

```
agnicFetch [unauthorized]: Unauthorized
```

#### Binance HW20 (`0xf977814e…`)

**FAILED** — code: `unauthorized`

```
agnicFetch [unauthorized]: Unauthorized
```

#### Lazarus EOA (`0x098B716B…`)

**FAILED** — code: `unauthorized`

```
agnicFetch [unauthorized]: Unauthorized
```

---

**Total spend:** $0.0525

## Analysis

Two distinct findings, one fixable, one not.

### Finding 1 — Adapter URL bug (FIXABLE, high impact)

**The pattern adapter is calling the wrong URL.** For both services, the
catalog `resource` is the **base URL** (e.g.
`https://orbisapi.com/proxy/crypto-address-labeler-api-79be80`), and the
base URL returns the *service descriptor* — a JSON document listing the
service name, version, and available sub-endpoints. It does NOT do any
address lookup; the `?address=` query is silently ignored.

Pass-1 evidence: all 3 wallets returned **byte-identical** responses on
both the labels and reputation services. Same `{ name, endpoints[],
docs }` blob, paid $0.005 each time.

This means **every `labels` and `web_sentiment` paid call in v6 was
buying a list of API endpoints**, not address data. The "Label/Reputation
provider returned only API metadata" finding in v6 verdicts was Opus
faithfully reporting exactly what came back — service metadata, not a
label miss.

Pass-2 evidence: hitting `…/label?address=...` (the documented
sub-endpoint from the descriptor) returns the proper structured shape:

```json
{
  "address": "...", "known_label": null, "entity_type": "unknown",
  "risk_level": "unknown", "is_known": false,
  "patterns": { "is_burn": false, "is_evm": true },
  "note": "Check Etherscan or Arkham for on-chain analysis",
  "source": "Address Labeler"
}
```

This is the real labels-API contract. The data fields are still null for
our 3 test wallets (see Finding 2), but the *response shape* is now
real, with `known_label` / `entity_type` / `risk_level` keys the
synthesizer could read.

**Fix needed:** the discovery / pattern-adapter layer needs to use the
action sub-endpoint, not the catalog root. Two paths:
1. **Catalog-side:** if the bazaar `inputInfo` declares
   `pathParams: { action: "label" }` or similar, the adapter should pick
   it up — verify what `inputInfo` actually contains for these two
   services in the discovery response.
2. **Adapter-side fallback:** when the root response shape matches
   `{ name, endpoints: string[], docs }`, treat it as a discovery hint
   and retry against the first non-`/openapi`/`/info` endpoint. This is
   a generic "service-descriptor-detection" heuristic.

Either way, this is the highest-leverage fix in the v6 follow-up set —
it converts 2 of the 4 paid categories from "noise-only" to "real data,
even if null."

### Finding 2 — Provider data gap (NOT fixable client-side)

Even with the correct sub-endpoint, the `/label` response on **all 3
test wallets** is:

| Field | Vitalik | Binance HW20 | Lazarus |
|---|---|---|---|
| `known_label` | null | null | null |
| `entity_type` | "unknown" | "unknown" | "unknown" |
| `risk_level` | "unknown" | "unknown" | "unknown" |
| `is_known` | false | false | false |

The provider's database doesn't know these addresses — not Vitalik
(ENS-doxxed, world-famous), not the Binance HW20 cold wallet (multi-
hundred-million-dollar institutional address), not Lazarus
(OFAC-sanctioned, named after the North Korean hacker group). That's a
real coverage gap; this "Address Labeler" service is a thin shell that
returns `is_known: false` for essentially everything.

The `/score` endpoint on the reputation service returns `401 Unauthorized`
through the agnic gateway — different auth layer or x402 paywall the
$0.0075 catalog price doesn't unlock. We couldn't probe what real score
data looks like, but the root descriptor's `description` field claims
the service "checks OFAC sanctions, scam reports, mixer proximity" —
which would ideally trigger on Lazarus + Tornado Cash if it actually
worked.

### Recommendations

1. **Investigate `inputInfo` for these two services first.** Read what
   the bazaar discovery response declares as the canonical input shape —
   does it include the sub-path? If yes, the pattern adapter has a bug
   in how it interprets `pathParams`. If no, the bazaar catalog entry
   itself is malformed (the catalog publishes a base URL where it
   should publish the action endpoint).
2. **Add a service-descriptor-detection heuristic** to `invoke_service`
   (or in the discovery rerank): if the response matches
   `{ name: string, endpoints: string[] }` AND ignores the address
   query, treat the call as a discovery failure (not a payment success).
   Reduce the service's `qualityScore` so the ranker stops picking it.
3. **Find providers that actually populate `known_label` for famous
   addresses.** If we can't, accept that `labels` and `web_sentiment`
   may stay informational-only on this catalog and lean harder on
   `sanctions` + `onchain_history` for verdict-driving signal (which is
   already what v6 verdicts effectively do).
4. **Separately track the `/score` 401.** If agnic surfaces a way to
   pass through additional credentials for paid-tier endpoints, it'd
   unlock the actual reputation data. Otherwise this service is
   functionally unusable.

