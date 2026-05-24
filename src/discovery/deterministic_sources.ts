// Hard-coded free chain-primitive sources that verify-agent runs alongside
// paid x402 services. They live outside the Bazaar catalog (no commercial
// relationship, no discovery), but the UI needs to show them so the plan
// card is a faithful preview of what an Execute run will actually touch.
//
// This module is presentation-only: it does NOT trigger any of the sources,
// it just describes them. The actual invocation logic lives in
// src/agent/verify.ts (Chainalysis fan-out, ENS resolver) and
// src/agent/labels_registry.ts (eth-labels supplement).

import type { Category } from "../agent/types.ts";
import type { WalletNetwork } from "./types.ts";

export interface DeterministicSource {
  category: Category;
  resource: string;
  rationale: string;
  // `false` for sources that always fire (Chainalysis fans across every
  // supported chain regardless of the categories request). `true` for sources
  // gated by a category being in the request — used by the UI if we ever
  // want to render gated sources differently.
  gated: boolean;
}

const CHAINALYSIS_SOURCE: DeterministicSource = {
  category: "sanctions",
  resource: "Chainalysis sanctions oracle (on-chain, 5 chains)",
  rationale:
    "Free on-chain sanctions check fanned across eth/base/polygon/arbitrum/optimism. If any chain returns isSanctioned=true the verify short-circuits to do_not_transact with no x402 spend.",
  gated: false,
};

const ETH_LABELS_SOURCE: DeterministicSource = {
  category: "labels",
  resource: "eth-labels.com label registry",
  rationale:
    "Free public mirror of Etherscan's label cloud (~170k addresses, 8 EVM chains). Merged into findings.labels alongside the paid labeler to catch known CEX hot wallets that Bazaar labelers miss.",
  gated: true,
};

const ENS_SOURCE: DeterministicSource = {
  category: "ens",
  resource: "ENS reverse resolver (Ethereum mainnet)",
  rationale:
    "Free on-chain ENS reverse lookup via the Universal Resolver. Resolves the address to its primary .eth name if one exists; mainnet-only by ENS design.",
  gated: true,
};

export function buildDeterministicSources(
  categories: Category[],
  _walletNetwork: WalletNetwork,
): DeterministicSource[] {
  const out: DeterministicSource[] = [CHAINALYSIS_SOURCE];
  if (categories.includes("labels")) out.push(ETH_LABELS_SOURCE);
  if (categories.includes("ens")) out.push(ENS_SOURCE);
  return out;
}
