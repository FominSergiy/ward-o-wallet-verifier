# drop-chain-selector-and-surface-direct-paths

## What

Removes the UI chain selector and infers chain context internally. The Chainalysis sanctions oracle now fans out across all 5 supported EVM chains in parallel — strictest result wins. Other chain-sensitive paths (x402 invocation, ENS, viem fallback, `isContract`) default to eth. Non-x402 chain-primitive paths (oracle per chain, ENS, viem onchain_history fallback) are now first-class nodes in the flow diagram.

## Why

Reported bug: address `0x7F367cC41522cE07553e823bf3be79A889DEbe1B` returned `do_not_transact` when the user picked `eth` but `safe_to_transact` when they picked `base`. Root cause — Chainalysis maintains a separate sanctions oracle deployment per chain, and the base deployment doesn't carry every OFAC SDN entry that eth's does. Forcing the user to pick the "right" chain was a usability hazard and could silently miss flagged addresses. The address shape (`0x` + 40 hex) cannot disambiguate eth from base from polygon etc., so the agent must check them all.

## Files

**Backend**

- `src/agent/types.ts` — drop `chain` from `VerifyRequestSchema`; error message updated.
- `src/agent/sanctions_oracle.ts` — export `ORACLE_SUPPORTED_CHAINS`.
- `src/agent/events.ts` — add `ServiceKind = "x402" | "direct"`; `ServiceEvent.kind?`.
- `src/agent/verify.ts` — `DEFAULT_CHAIN = "eth"`; `checkOracleAcrossChains` fan-out; `resolveEnsWithEvents` wrapper emits structured `service` events.
- `src/agent/invoke_all.ts` — tag viem fallback service events with `kind: "direct"`.

**Frontend**

- `web/src/types.ts` — `ServiceKind`; `ServiceEvent.kind?`; drop `chain` from `SavedPlan`.
- `web/src/api.ts` — `streamVerify` no longer takes `chain`.
- `web/src/components/InputForm.tsx` — drop `<select>` and chain prop.
- `web/src/App.tsx` — drop chain state.
- `web/src/hooks/useFlowState.ts` — `DirectNode[]` track on each `CategoryNode`; `direct` detection by `kind` or resource prefix.
- `web/src/components/FlowDiagram.tsx` — render direct nodes as small dashed circles below each category row; categories with only direct paths (e.g. sanctions short-circuit) connect straight to synth.
- `web/src/components/FlowDiagram.css` — `.direct-node` + `.direct-label` styles.

**Tests**

- `src/agent/verify_test.ts` — rewritten oracle stubs as `(address, chain) => OracleResult`; new test asserts the reported bug address short-circuits when only eth flags it; new test asserts 5 oracle service events emitted; ENS test asserts the new service event flow.
- `src/routes/verify_agent_test.ts` — drop chain from bodies; add Solana-shape 400 test and no-chain-field acceptance test.
- `src/routes/verify_agent_stream_test.ts` — drop chain from bodies and signature.

## Config

No new env vars. Existing oracle RPC overrides (`RPC_URL_{CHAIN}_ORACLE`) cover the per-chain fan-out.

## Notes

- The `/invoke` debug route still accepts a `chain` param (left as a developer escape hatch — it's not driven by the UI).
- Verdict's `chain` field now reports DEFAULT_CHAIN (eth) for normal verdicts, and the flagging chain (whichever oracle returned true) for the short-circuit verdict.
- Browser verification was not run end-to-end in the worktree (port-conflict with another developer session; `.env` copy refused by sandbox). Manually verify against the bug-report address before merging:
  1. `~/.deno/bin/deno task dev` + `cd web && npm run dev`.
  2. Submit `0x7F367cC41522cE07553e823bf3be79A889DEbe1B` — expect `do_not_transact` and 5 dashed circles under the sanctions row, eth one red.
  3. Submit `9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` (Solana) — expect 400 with EVM message.
- The flow diagram viewBox grew from 480→520px to accommodate the direct-node row beneath each category; CSS preserves aspect ratio.
- Follow-up: if address coverage for non-Eth EVM chains becomes important (base-native scammers etc.) we should expand x402 invocation to also fan out, not just the oracle.
