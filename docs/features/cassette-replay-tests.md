**What:** Offline cassette-based regression suite — records all HTTP interactions for each fixture wallet, then replays them deterministically to assert 9/9 verdict accuracy in <1s with zero paid calls.

**Files:**
- `src/testing/fetch_interceptor.ts` — FIFO recording + replay interceptors that patch `globalThis.fetch`
- `scripts/record-cassettes.ts` — one-shot recorder; writes `tests/cassettes/<address>.json` per fixture
- `tests/cassettes/` — committed cassette files (one per fixture wallet)
- `tests/replay_test.ts` — replay test suite (`deno task test:replay`)
- `deno.json` — `cassette:record` and `test:replay` tasks

**Config:**
- Both tasks set `HEALTH_TRACKING=false` to keep in-memory health state deterministic across recording and replay runs.
- `tests/replay_test.ts` sets `AGNIC_API_KEY=cassette-replay-dummy` at module level — all fetch calls are intercepted so the real key is never sent.

**Notes:**
- Cassettes use URL-only (METHOD:URL) FIFO keys — no body matching. This avoids dynamic-content mismatches (timestamps in LLM prompts, JSON-RPC `id` fields). Call ORDER per URL must be stable, which holds for a deterministic pipeline.
- Re-record with `deno task cassette:record` any time the pipeline's HTTP call graph changes (new service, different ranking, prompt changes).
- Recording runs all 9 wallets in a single process so the in-memory health store evolves identically to the replay test run (same ordering, same failures → same ranker input for each wallet).
