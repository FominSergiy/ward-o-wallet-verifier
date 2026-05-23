# ui-wardo-styling

**What:** Adds the Ward-o mascot character to the web UI — a neutral shield variant in the header, green/villain variants in the verdict card driven by the verdict class, and a pixelated tamagotchi above the flow/logs panel that idles when waiting and "walks in place" (CSS sprite-sheet) while either the plan or verify-agent stream is in flight.

**Files:**

Added:
- `web/public/wardo/wardo-neutral.svg` — header mascot
- `web/public/wardo/wardo-safe.svg` — green/happy variant (verdict: safe_to_transact)
- `web/public/wardo/wardo-villain.svg` — red/horned variant (verdict: do_not_transact)
- `web/public/wardo/wardo-pixel-idle.svg` — 16×16 single-frame pixel sprite
- `web/public/wardo/wardo-pixel-walk.svg` — 4-frame horizontal sprite strip (64×16 viewBox) for the walk animation
- `web/src/components/WardoMascot.tsx` — `<img>` wrapper, variant: `"neutral" | "safe" | "villain"`
- `web/src/components/PixelWardo.tsx` — tamagotchi component, `active: boolean` prop
- `web/src/components/PixelWardo.css` — sprite sizing + `pixel-wardo-walk` keyframes + `image-rendering: pixelated`

Modified:
- `web/src/components/Logo.tsx` — wraps title in `.logo-row` flex container with the neutral mascot to the right
- `web/src/components/VerdictCard.tsx` — adds `mascotVariant(cls)` helper, places the variant mascot in the card header
- `web/src/App.tsx` — renders `<PixelWardo active={planStreaming || verifyStreaming} />` directly above `<TerminalTabs/>` inside the existing `{showTerminal && ...}` guard
- `web/src/theme.css` — appends `.logo-row`, `.logo-text`, `.logo-mascot`, `.verdict-card-header`, `.verdict-card-title`, `.verdict-mascot` rules; tagline `margin-bottom` moved to `.logo-row`; small `@media (max-width: 520px)` block for mobile

**Config:** No new env vars. Existing CSS custom properties `--safe` / `--risk` / `--muted` / `--fg` are reused to color the SVGs at write-time (hex inlined for cross-context rendering). The walk animation period is 0.5s with `steps(4)` — adjust in `PixelWardo.css`.

**Worktree-local dev settings (not committed):**
- `web/vite.config.ts` `server.port: 5273` (was 5173)
- `.env`: `PORT=8273`, `VITE_API_PORT=8273`, `ALLOWED_ORIGIN=http://localhost:5273`
- `.claude/launch.json`: added `wardo-web-wt` entry that runs `./node_modules/.bin/vite --port 5273 --strictPort` from the worktree's `web/` dir

**Notes / follow-ups:**
- SVGs are placeholders authored in code; swap for polished artwork later by replacing the files in `web/public/wardo/` (filenames are the contract).
- The walk sprite is on a 16-pixel grid scaled 4× via CSS `background-size`; `image-rendering: pixelated` keeps edges crisp on retina + scaled displays.
- `VerdictCard` shows the neutral variant for `insufficient_data`. If we want to hide the mascot entirely in that case, gate the `<WardoMascot/>` render on `cls !== "insufficient_data"`.
- The pixel tamagotchi only appears once `showTerminal` is true (i.e., after the first Plan/Execute click). Pre-run, the header mascot carries the page identity alone.
- Verified end-to-end in the browser at `http://localhost:5273`:
  - Header neutral mascot renders.
  - PixelWardo idles ("standing by", breathing keyframe) and switches to walking ("ward-o is working...", sprite animation `pixel-wardo-walk`) while a fetch is in flight; stops when the stream resolves.
  - VerdictCard shows the green mascot for `safe_to_transact` and the villain for `do_not_transact` (mocked via fetch interception in the dev preview; SSE schema unchanged).
  - `npx tsc --noEmit` is clean; no console errors; all `/wardo/*.svg` requests return 200.
