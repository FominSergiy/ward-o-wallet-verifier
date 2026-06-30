# verifier-state-persistence

**What:** The `/verify` page now retains all its state (typed EVM address,
verdict card, plan card, terminal logs, active tab, and any in-flight SSE check)
when the user navigates to `/`, `/blog`, or `/docs` and back.

**Files:**

- `web/src/App.tsx` — `VerifierApp` is now rendered once at the `App` level and
  kept mounted across navigation. It is wrapped in a div toggled between
  `display: contents` (on `/verify`, so the cards keep their place in the `.app`
  layout) and `display: none` (elsewhere). The `/verify` case was removed from
  `route()`, which now only handles the other pages and is rendered only when
  not on `/verify`.

**Config:** none.

**Notes:**

- The fix relies on React preserving component state while it stays mounted — no
  serialization. This is why mid-flight SSE streams also survive (the
  unmount-cleanup that aborts them in
  `web/src/components/VerifierApp.tsx` no longer fires on navigation).
- `VerifierApp.tsx`, `storage.ts`, and `router.ts` were not changed. The
  existing "Save plan" → `loadLastPlan()` localStorage path still handles full
  page reloads.
- `display: contents` is used (not a block) specifically so the wrapper
  generates no box and the existing flex/gap layout is unchanged when visible.
- Verified in the browser preview: typed address survives
  `/verify → /blog → /verify` and the browser back/forward (`popstate`) path;
  verifier is hidden (`offsetParent === null`) on other pages with no duplicate
  DOM/inputs; no console errors. The verdict-card path was not exercised live
  (needs the backend + a paid/recorded check) but is preserved by the same
  single-mount mechanism as the address.
