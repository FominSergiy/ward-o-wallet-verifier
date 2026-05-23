export type Chain = "eth" | "base" | "polygon" | "arbitrum" | "optimism";

export type Category =
  | "sanctions"
  | "labels"
  | "onchain_history"
  | "web_sentiment"
  | "ens"
  | "contract_analysis";

export type WalletNetwork = "base" | "base-sepolia";

export interface PlanViewService {
  category: Category;
  resource: string;
  priceUsdc: number;
  rationale: string;
}

// PlanView is the projection that the /discover-stream `plan` event ships and
// that PlanCard renders. It's a strict subset of the backend DiscoveryPlan —
// alternates, payTo/scheme/qualityScore, etc. aren't surfaced in the UI.
export interface PlanView {
  services: PlanViewService[];
  totalEstimatedCostUsdc: number;
  walletNetwork: WalletNetwork;
  unresolvedCategories: Category[];
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

export interface ServiceEvent {
  type: "service";
  status: "start" | "ok" | "error" | "fallback";
  category: Category;
  resource: string;
  priceUsdc?: number;
  amountUsdc?: number;
  durationMs?: number;
  error?: string;
  at: string;
}

export interface PlanEvent {
  type: "plan";
  services: { category: Category; resource: string; priceUsdc: number; rationale: string }[];
  totalEstimatedCostUsdc: number;
  walletNetwork: WalletNetwork;
  unresolvedCategories?: Category[];
  at: string;
}

export interface VerifyReceipt {
  category: Category;
  resource: string;
  status: "ok" | "error" | "skipped";
  adapterPath?: string;
  amountUsdc?: number;
  durationMs?: number;
  paid?: boolean;
  error?: string;
}

export type VerdictLabel = "safe_to_transact" | "do_not_transact" | "insufficient_data";
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
  plan: { services: { category: Category; resource: string; priceUsdc: number; rationale: string }[] };
  receipts: VerifyReceipt[];
  walletNetwork: WalletNetwork;
  totalSpentUsdc: number;
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
  chain: Chain;
  plan: PlanView;
  savedAt: string;
}
