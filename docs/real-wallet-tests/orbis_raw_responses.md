# Orbisapi raw response inspection

**Date:** 2026-05-23T14:09:41.908Z

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

(To be filled in after reviewing the raw payloads above. Key questions: are entity/label/score fields actually populated for any of the three wallets? If yes — which fields, and is the synthesizer prompt seeing them? If no — what fields ARE populated, and can we steer the synthesizer/query to providers that surface more substantive data?)

