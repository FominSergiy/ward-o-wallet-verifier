# Monetization Report
**Report ID:** report-company-risk-score-fixture-v1
**Generated:** 2026-05-16T00:00:00.000Z
**Fixture mode:** yes
**Readiness score:** 82/100
## Summary
POST /company-risk-score is a data_api endpoint for procurement teams and AI research agents. Per-call pricing with hybrid x402/API access fits low-frequency, high-value, machine-callable endpoint.
## Endpoint
- **Method:** POST
- **Path:** /company-risk-score
- **Domain:** data_api
- **Target users:** procurement teams and AI research agents
- **Estimated cost per call:** $0.04 USD
- **Expected usage:** low-frequency, high-value, machine-callable endpoint
- **Inputs:** companyName, domain
- **Outputs:** risk score, sanctions flags, ESG notes, supplier notes
## Pricing
- **Model:** per_call
- **Suggested price per call:** $0.12 USD
- **Estimated margin:** 67%
- **Rationale:** 3x upstream cost ($0.04) supports per-call margin for data_api workloads.
## Quota
- **Tier:** starter
- **Requests per day:** 500
- **Burst limit:** 20
- **Rationale:** Starter quota matches low-frequency, high-value, machine-callable endpoint for procurement teams and AI research agents.
## Access model
- **Primary:** hybrid
- **Secondary:** api_key, x402
- **Agent ready:** yes
- **Human ready:** yes
- **Rationale:** POST /company-risk-score is callable by agents (x402) and humans (API key).
## x402 suitability
- **Score:** 88/100 (high)
- **Machine callable:** yes
- **Idempotent:** yes
- **Rationale:** Structured inputs (companyName, domain) and machine callers suit x402 for /company-risk-score.
- **Blockers:**
- Live settlement remains deferred in this demo.
## Abuse and cost risks
- High-cardinality companyName/domain lookups can inflate upstream costs.
- Repeated retries on invalid data_api requests may waste paid quota.
- Automated agents calling /company-risk-score without rate limits can spike spend.
## Simulated paid call
- **Call ID:** sim-call-company-risk-score-001
- **Status:** settled_simulated
- **Price charged:** $0.12 USD
- **Payer:** agent
- **Summary:** Simulated paid call to /company-risk-score returned risk score and sanctions flags.