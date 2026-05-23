import type { Category } from "./types.ts";
import type { WalletNetwork } from "../discovery/types.ts";

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

// "kind" distinguishes paid x402 service calls (default) from free chain
// primitives like the Chainalysis sanctions oracle, ENS reverse resolution,
// and the viem onchain_history fallback. The UI uses this to render direct
// paths with distinct styling (no payment diamond, dashed border).
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

export interface PlanEventService {
  category: Category;
  resource: string;
  priceUsdc: number;
  rationale: string;
}

export interface PlanEvent {
  type: "plan";
  services: PlanEventService[];
  totalEstimatedCostUsdc: number;
  walletNetwork: WalletNetwork;
  // Populated by /discover-stream so the UI can surface categories with no
  // viable service. verify.ts intentionally omits this — its plan emission
  // is a mid-pipeline status, not the final discover result.
  unresolvedCategories?: Category[];
  at: string;
}

export interface ResultEvent {
  type: "result";
  // Shape matches the JSON body returned by POST /verify-agent. Kept as
  // `unknown` here to avoid a circular import on the response shape; the
  // /verify-agent-stream route is responsible for constructing the payload.
  payload: unknown;
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

export type EventEmitter = (e: VerifyEvent) => void;

export const noopEmit: EventEmitter = (_e) => {};

export function now(): string {
  return new Date().toISOString();
}

// Invoke an emitter without letting a consumer exception crash the caller.
// Pipeline code calls this instead of the raw emitter so a broken UI/SSE
// listener cannot break verification.
export function safeEmit(emit: EventEmitter | undefined, e: VerifyEvent): void {
  if (!emit) return;
  try {
    emit(e);
  } catch (_err) {
    // intentionally swallowed — emitter must never throw upward
  }
}
