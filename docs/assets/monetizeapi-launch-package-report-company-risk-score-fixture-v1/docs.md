# Company Risk Score API

Call POST /company-risk-score with companyName and domain to retrieve risk score and sanctions flags.

## Endpoint

`POST /company-risk-score`

## Example request

```http
POST /company-risk-score
{
  "companyName": "Example Corp",
  "domain": "example.com"
}
```

## Example response

```json
{
  "risk score": "...",
  "sanctions flags": "...",
  "ESG notes": "...",
  "supplier notes": "..."
}
```

## Usage

# Company Risk Score API

Call `POST /company-risk-score` with `companyName`, `domain`.

Returns risk score, sanctions flags, ESG notes, supplier notes.
