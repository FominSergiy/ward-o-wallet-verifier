# Paid Call Simulation

**Simulation ID:** sim-timeline-company-risk-score-v1
**Report ID:** report-company-risk-score-fixture-v1
**Generated:** 2026-05-16T00:00:00.000Z
**Settlement mode:** simulated

## Endpoint request

`POST /company-risk-score`

```json
{
  "companyName": "Example Corp",
  "domain": "example.com"
}
```

## Payment required

- **HTTP status:** 402
- **Reason:** Payment required before tool execution (x402 simulated).
- **Price per call:** $0.12 USD
- **Resource:** /company-risk-score

## Payment authorization

- **Call ID:** sim-call-company-risk-score-001
- **Status:** settled_simulated
- **Charged:** $0.12 USD
- **Payer:** agent

## Tool call

- **Tool:** company-risk-score
- **Allowed:** yes

## Usage event

- **Event ID:** usage-company-risk-score-001
- **Caller:** agent
- **Units:** 1
- **Cost:** $0.04 USD
- **Outcome:** success

## Timeline

### Step 1: Endpoint request

- **Time:** 2026-05-16T00:00:00.000Z
- **Summary:** POST /company-risk-score received from agent caller.

### Step 2: Payment required (402)

- **Time:** 2026-05-16T00:00:00.100Z
- **Summary:** HTTP 402 returned with x402 metadata for $0.12 USD per call.

### Step 3: Payment authorized (simulated)

- **Time:** 2026-05-16T00:00:00.200Z
- **Summary:** Simulated payment settled_simulated for call sim-call-company-risk-score-001.

### Step 4: Tool call allowed

- **Time:** 2026-05-16T00:00:00.300Z
- **Summary:** MCP tool company-risk-score execution allowed after simulated authorization.

### Step 5: Usage recorded

- **Time:** 2026-05-16T00:00:00.400Z
- **Summary:** Usage event usage-company-risk-score-001 recorded with outcome success.
