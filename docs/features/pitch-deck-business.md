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

---

## Workshop #2 update (2026-05-23, branch `feat/pitch-deck-workshop2`)

Second pitch clinic surfaced four ideas. After a critical pass, only two earned slide-space; the rest landed in speaker notes.

**Changed slides:**

- **Slide 6** — replaced the Why-Now tech timeline (x402 → Smart Wallets → agentic commerce → no safety layer) with a 4-rung **adoption staircase**: Today (devs / Maya) → Next 12 mo (companies) → 2–3 years (consumer apps with agent checkout) → Far future (regular people doing crypto via ChatGPT-class assistants). Pins use staggered top-margins to render as a literal staircase. Closes with: *"We start where the pain is felt today. We become the safety layer for the agent economy tomorrow."* This was the workshop's biggest critique (vision too small) and it's the only change that meaningfully shifts what the deck *is about*.
- **Slide 8** — added a one-line Stripe/Twilio playbook intro above the GTM list. Names the pattern investors recognize without adding visual weight.

**Speaker notes deepened (slides 1, 2, 4, 6, 8):**

- Slide 1: Grok/Bankr March 2025 incident as Q&A defense — the deck still uses the hypothetical scene because the real incident (agent accumulating $500K from a tweet-deployed token) is about agent *surprise behavior*, not about paying a sanctioned counterparty. The hypothetical is hypothetical but truthful about the shape of the problem.
- Slide 2: CoinDesk (Apr 2026) + TRM Labs links for "is anyone else naming this category" Q&A.
- Slide 4: guardrail framing as backup metaphor when seatbelt doesn't land technically.
- Slide 6: rung-by-rung timeline rationale; explicit "devs are the wedge, not the destination."
- Slide 8: Stripe (~$1B ARR at year 9) and Twilio (~$1B at year 10) comparables.

**Ideas considered and rejected:**

- Replacing the cold-open scene with the Grok/Bankr incident — wrong shape (agent surprise behavior, not bad-counterparty payment). Would muddy the value prop on the most important slide.
- Adding a guardrail line alongside seatbelt on Slide 4 — competes with the hero metaphor; audiences remember one line.
- Adding industry-recognition badges to visible Slide 2 — adds content without changing what the slide *means*.

**Word-count / timing impact:** none. Staircase content roughly matches the timeline it replaces; Slide 8 addition is one sentence. Deck stays at 9 slides.
