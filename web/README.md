# WARD-o demo UI

Vite + React single page that drives the Deno backend (`/discover` and `/verify-agent-stream`).

## Setup

```bash
cd web
npm install
npm run dev
```

The dev server runs on `http://localhost:5173`. Vite proxies `/discover`,
`/verify-agent`, `/verify-agent-stream`, and `/health` to the backend on
`http://localhost:8000`, so no CORS configuration is needed in dev.

Set `VITE_API_BASE_URL` in `web/.env` for prod builds; leave it blank to use the
dev proxy.

## Manual smoke (F-2..F-5)

Start the backend (`deno task dev`) and the frontend (`npm run dev`), then:

- **F-2 Plan**
  - Valid address → click Plan → plan card lists each category and total.
  - Invalid address → Plan button disabled, hint shown.
  - Unfunded wallet → error panel with both addresses.
- **F-3 Save**
  - Plan, click Save, refresh → form and plan card restored.
  - Plan, click Save, Plan a different address without saving, refresh → previous saved plan still restored.
- **F-4 Stream**
  - Click Execute → log panel fills line-by-line (phase / service / plan).
  - Click Execute mid-run → first stream stops, second starts cleanly.
  - `error` frame → red line, no verdict card.
- **F-5 Verdict**
  - Happy run → verdict card appears, color-coded by `safe` flag.
  - Synthesis failure → stub verdict with the error string above it.

## Typecheck / build

```bash
npm run typecheck
npm run build
```
