# pitch-deck-business

**What:** A business-side HTML pitch deck for Ward-o (3-min runtime, 9 slides) that leads with story and benefits instead of architecture. Sits alongside the existing technical deck.

**Files:**
- `docs/WARD-o-business.html` (new) — the deck
- `docs/agent-log.md` — log row
- Reuses (read-only): `docs/assets/ward-o.svg`, `docs/assets/ward-o-safe.svg`, `docs/assets/ward-o-villain.svg`

**Config:** None. Static HTML, no build step. Open in any browser.

**Notes:**

- **Story arc:** toddler-with-credit-card cold open → meet "Maya" (named ICP persona, agent-platform builder) → Ward-o-is-the-seatbelt one-liner → benefits (Time/Money/Trust) → why-now timeline → competitive 2×2 → TAM/SAM/SOM + GTM → team + ask + demo handoff.
- **Speaker notes:** every slide has a `<aside class="speaker-notes">` block carrying Q&A defense (market sources, competitor positioning, ICP rationale). Toggle by appending `?notes` to the URL — body stacks the slides vertically with notes underneath each.
- **Nav:** arrow keys, space, click L/R half, swipe. Same script as `docs/WARD-o.html`.
- **Style:** reuses palette (`#F5F2EC` / `#1A1A1A` / `#3E8B57` / `#B0413E`) and Helvetica Neue + Menlo from the technical deck.
- **Reading-pace check:** ~537 words across 9 slides ≈ 3:35 cold-read at 150 wpm. Presentation pace runs shorter — narrator speaks ~60% of slide word count and lets bullets do the rest. Practice trims this comfortably under 3:00.
- **Known gaps / follow-ups:**
  - Market-size figures (TAM $11B, SAM $400M) are directional. Caveat lives in the slide and speaker notes. Tighten with cited sources before any investor meeting.
  - The "Maya" persona is composite, not a real design partner. Replace with a real named partner once one is signed.
  - Adjacent ICPs (crypto exchanges, RegTech) are referenced in speaker notes only — if the pitch audience shifts toward enterprise, build a second variant anchored on exchange/wallet integration.
