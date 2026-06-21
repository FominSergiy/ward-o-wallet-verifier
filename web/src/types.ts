export type Chain = "eth" | "base" | "polygon" | "arbitrum" | "optimism";

export type Category =
  | "sanctions"
  | "labels"
  | "onchain_history"
  | "web_sentiment"
  | "ens";

export type WalletNetwork = "base" | "base-sepolia";

export interface PlanViewService {
  category: Category;
  resource: string;
  priceUsdc: number;
  rationale: string;
}

// Free chain-primitive sources verify-agent runs alongside paid x402 services.
// Mirrors src/discovery/deterministic_sources.ts DeterministicSource. Rendered
// in PlanCard with $0 cost so users see the full set of endpoints that will
// be touched on Execute.
export interface DeterministicSourceView {
  category: Category;
  resource: string;
  rationale: string;
  gated: boolean;
}

// PlanView is the projection that the /discover-stream `plan` event ships and
// that PlanCard renders. It's a strict subset of the backend DiscoveryPlan —
// alternates, payTo/scheme/qualityScore, etc. aren't surfaced in the UI.
export interface PlanView {
  services: PlanViewService[];
  totalEstimatedCostUsdc: number;
  walletNetwork: WalletNetwork;
  unresolvedCategories: Category[];
  deterministicSources: DeterministicSourceView[];
}

export interface UnfundedError {
  error: "wallet_unfunded";
  message: string;
  baseAddress: string | null;
  baseSepoliaAddress: string | null;
}

export interface ApiError {
  error: string;
  message: string;
  status?: number;
  [k: string]: unknown;
}

// SSE event shapes mirroring src/agent/events.ts on the backend
export type EventPhase = "preflight" | "discover" | "invoke" | "synthesize";
export type EventLevel = "info" | "warn" | "error";

export interface PhaseEvent {
  type: "phase";
  phase: EventPhase;
  status: "start" | "end";
  at: string;
}

export interface LogEvent {
  type: "log";
  level: EventLevel;
  message: string;
  at: string;
}

// Mirrors src/agent/events.ts ServiceKind. "direct" = free chain primitive
// (Chainalysis oracle, ENS resolver, viem onchain_history fallback). When
// absent the path is treated as an x402 paid call.
export type ServiceKind = "x402" | "direct";

export interface ServiceEvent {
  type: "service";
  status: "start" | "ok" | "error" | "fallback";
  category: Category;
  resource: string;
  kind?: ServiceKind;
  priceUsdc?: number;
  amountUsdc?: number;
  durationMs?: number;
  error?: string;
  at: string;
}

export interface PlanEvent {
  type: "plan";
  services: {
    category: Category;
    resource: string;
    priceUsdc: number;
    rationale: string;
  }[];
  totalEstimatedCostUsdc: number;
  walletNetwork: WalletNetwork;
  unresolvedCategories?: Category[];
  deterministicSources?: DeterministicSourceView[];
  at: string;
}

export interface VerifyReceipt {
  category: Category;
  resource: string;
  status: "ok" | "error" | "skipped";
  // "pattern" = direct pattern-adapter call, "pattern+subpath" = descriptor
  // payload was resolved by retrying against a sub-endpoint (see
  // docs/features/adapter-descriptor-retry.md), "llm" = LLM-built fallback.
  adapterPath?: "pattern" | "pattern+subpath" | "llm";
  amountUsdc?: number;
  durationMs?: number;
  paid?: boolean;
  error?: string;
  // Machine code for the error (e.g. "descriptor_only_response"); kept in
  // sync with the backend payload at src/routes/verify_agent_stream.ts.
  errorCode?: string;
}

export type VerdictLabel =
  | "safe_to_transact"
  | "do_not_transact"
  | "insufficient_data";
export type Confidence = "low" | "medium" | "high";
export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface SignalFinding {
  category: Category;
  severity: Severity;
  finding: string;
}

export interface Coverage {
  requested: Category[];
  resolved: Category[];
  unresolved: Category[];
  not_applicable?: Category[];
}

export interface VerifyVerdict {
  address: string;
  chain: string;
  safe: boolean;
  verdict: VerdictLabel;
  confidence: Confidence;
  headline: string;
  reasoning: string;
  findings: SignalFinding[];
  coverage: Coverage;
  totalSpentUsdc: number;
  generatedAt: string;
}

export interface VerifyResultPayload {
  verdict: VerifyVerdict;
  synthesisError?: string | null;
  plan: {
    services: {
      category: Category;
      resource: string;
      priceUsdc: number;
      rationale: string;
    }[];
  };
  receipts: VerifyReceipt[];
  walletNetwork: WalletNetwork;
  totalSpentUsdc: number;
  // Total USD spent on AI model calls this run (synthesis + discovery LLM
  // calls). x402 paid-service spend lives in totalSpentUsdc; the card shows
  // both plus their sum. Zero on cache hits (no model call ran).
  totalLlmCostUsd: number;
}

export interface ResultEvent {
  type: "result";
  payload: VerifyResultPayload;
  at: string;
}

export interface ErrorEvent {
  type: "error";
  code: string;
  message: string;
  status?: number;
  at: string;
}

export type VerifyEvent =
  | PhaseEvent
  | LogEvent
  | ServiceEvent
  | PlanEvent
  | ResultEvent
  | ErrorEvent;

export interface SavedPlan {
  address: string;
  plan: PlanView;
  savedAt: string;
}
