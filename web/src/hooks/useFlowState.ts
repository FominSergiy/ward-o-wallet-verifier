import { useMemo } from "react";
import type {
  Category,
  ServiceKind,
  VerdictLabel,
  VerifyEvent,
} from "../types";

export type NodeStatus = "idle" | "active" | "ok" | "error" | "fallback";

export interface DirectNode {
  // The unique resource URI (e.g. "chainalysis_oracle://eth", "viem://base",
  // "ens://eth"). Used as a stable key for re-renders.
  resource: string;
  // Short user-facing label — chain name for oracle, "viem/<chain>" for the
  // onchain_history fallback, "ens" for ens.
  label: string;
  status: NodeStatus;
  durationMs?: number;
  error?: string;
}

export interface CategoryNode {
  status: NodeStatus;
  primary: {
    resource: string;
    status: NodeStatus;
    priceUsdc?: number;
    amountUsdc?: number;
    durationMs?: number;
    error?: string;
  };
  fallback?: {
    resource: string;
    status: NodeStatus;
    priceUsdc?: number;
    amountUsdc?: number;
    error?: string;
  };
  // Free chain-primitive paths (Chainalysis oracle per chain, viem fallback,
  // ENS reverse) that ran for this category. Rendered as a row of small
  // circles under the x402 diamond in the flow diagram.
  direct: DirectNode[];
}

export interface FlowState {
  origin: NodeStatus;
  categories: Record<string, CategoryNode>;
  categoryOrder: Category[];
  synthesize: NodeStatus;
  verdict: { status: NodeStatus; label?: VerdictLabel };
  spentUsdc: number;
  estimatedUsdc: number;
}

function emptyState(): FlowState {
  return {
    origin: "idle",
    categories: {},
    categoryOrder: [],
    synthesize: "idle",
    verdict: { status: "idle" },
    spentUsdc: 0,
    estimatedUsdc: 0,
  };
}

function ensureCategory(state: FlowState, cat: Category): CategoryNode {
  if (!state.categories[cat]) {
    state.categories[cat] = {
      status: "idle",
      primary: { resource: "", status: "idle" },
      direct: [],
    };
    if (!state.categoryOrder.includes(cat)) state.categoryOrder.push(cat);
  }
  return state.categories[cat];
}

// Direct paths are tagged by the backend with kind="direct"; the resource-
// prefix check is a fallback for older event streams (or future direct
// providers) that didn't set the flag.
function isDirectKind(
  kind: ServiceKind | undefined,
  resource: string,
): boolean {
  if (kind === "direct") return true;
  return (
    resource.startsWith("chainalysis_oracle://") ||
    resource.startsWith("viem://") ||
    resource.startsWith("ens://")
  );
}

function directLabel(resource: string): string {
  const sepIdx = resource.indexOf("://");
  if (sepIdx === -1) return resource;
  const scheme = resource.slice(0, sepIdx);
  const rest = resource.slice(sepIdx + 3);
  if (scheme === "chainalysis_oracle") return rest;
  if (scheme === "ens") return "ens";
  if (scheme === "viem") return `viem/${rest}`;
  return resource;
}

function ensureDirect(node: CategoryNode, resource: string): DirectNode {
  let d = node.direct.find((x) => x.resource === resource);
  if (!d) {
    d = { resource, label: directLabel(resource), status: "idle" };
    node.direct.push(d);
  }
  return d;
}

export function deriveFlowState(events: VerifyEvent[]): FlowState {
  const s = emptyState();
  let activePhase: "discover" | "invoke" | "synthesize" | null = null;

  for (const ev of events) {
    switch (ev.type) {
      case "phase":
        if (ev.status === "start") {
          activePhase = ev.phase === "preflight" ? null : ev.phase;
          if (ev.phase === "discover") s.origin = "active";
          if (ev.phase === "synthesize") s.synthesize = "active";
        } else {
          if (ev.phase === "discover" && s.origin !== "error") s.origin = "ok";
          if (ev.phase === "synthesize" && s.synthesize === "active") {
            s.synthesize = "ok";
          }
          if (ev.phase === "invoke") {
            // Cascade any leftover idle categories — they were skipped silently.
            // Any sub-node still "active" at invoke-end means the attempt
            // ended without resolution; treat it as an error.
            for (const cat of s.categoryOrder) {
              const node = s.categories[cat];
              if (!node) continue;
              if (node.status === "idle") node.status = "ok";
              if (node.primary.status === "active") {
                node.primary.status = "error";
              }
              if (node.fallback?.status === "active") {
                node.fallback.status = "error";
              }
              for (const d of node.direct) {
                if (d.status === "active") d.status = "error";
              }
              if (node.status === "active") {
                // For direct-only categories (no x402 primary), a successful
                // direct path means the category resolved OK — flip to "ok"
                // rather than "error", and only error if every direct failed.
                const hasX402 = node.primary.resource !== "";
                const directOk = node.direct.some((d) => d.status === "ok");
                const directError = node.direct.some((d) =>
                  d.status === "error"
                );
                if (!hasX402 && directOk && !directError) {
                  node.status = "ok";
                } else {
                  node.status = "error";
                }
              }
            }
          }
        }
        break;

      case "plan":
        s.origin = "ok";
        s.estimatedUsdc = ev.totalEstimatedCostUsdc;
        for (const svc of ev.services) {
          const node = ensureCategory(s, svc.category);
          node.primary.resource = svc.resource;
          node.primary.priceUsdc = svc.priceUsdc;
        }
        break;

      case "service": {
        const node = ensureCategory(s, ev.category);

        // Direct (chain-primitive) paths render as auxiliary nodes — they
        // don't displace the x402 primary/fallback. Track them on their own
        // status track so the oracle fan-out (5 nodes) and ENS / viem all
        // coexist with paid x402 calls in the same category row.
        if (isDirectKind(ev.kind, ev.resource)) {
          const d = ensureDirect(node, ev.resource);
          if (ev.status === "start") {
            d.status = "active";
            if (node.status === "idle") node.status = "active";
          } else if (ev.status === "ok") {
            d.status = "ok";
            if (ev.durationMs != null) d.durationMs = ev.durationMs;
            // Promote category status to "ok" once any direct path succeeds,
            // provided no x402 primary is mid-flight/errored and no sibling
            // direct path failed. Without this, the per-event "start" handler
            // leaves node.status stuck at "active" and the invoke-end cascade
            // flips direct-only categories (ENS) to "error" even on success.
            if (
              (node.status === "idle" || node.status === "active") &&
              node.primary.status !== "active" &&
              node.primary.status !== "error" &&
              !node.direct.some((x) => x.status === "error")
            ) {
              node.status = "ok";
            }
          } else if (ev.status === "error") {
            d.status = "error";
            d.error = ev.error;
            // Direct paths failing shouldn't poison the category — the x402
            // path is independent. Only flip to error if nothing else ran.
            if (
              node.status === "idle" &&
              node.primary.status === "idle" &&
              !node.fallback
            ) {
              node.status = "error";
            }
          }
          break;
        }

        const isFallbackAttempt = node.primary.resource !== "" &&
          node.primary.resource !== ev.resource;

        if (ev.status === "start") {
          node.status = "active";
          if (isFallbackAttempt) {
            node.fallback = {
              resource: ev.resource,
              status: "active",
              priceUsdc: ev.priceUsdc,
            };
          } else {
            if (!node.primary.resource) node.primary.resource = ev.resource;
            node.primary.status = "active";
            if (ev.priceUsdc != null) node.primary.priceUsdc = ev.priceUsdc;
          }
        } else if (ev.status === "ok") {
          if (isFallbackAttempt && node.fallback) {
            node.fallback.status = "ok";
            if (ev.amountUsdc != null) node.fallback.amountUsdc = ev.amountUsdc;
          } else {
            node.primary.status = "ok";
            if (ev.amountUsdc != null) node.primary.amountUsdc = ev.amountUsdc;
            if (ev.durationMs != null) node.primary.durationMs = ev.durationMs;
          }
          node.status = "ok";
          if (ev.amountUsdc != null) s.spentUsdc += ev.amountUsdc;
        } else if (ev.status === "error") {
          if (isFallbackAttempt && node.fallback) {
            node.fallback.status = "error";
            node.fallback.error = ev.error;
          } else {
            node.primary.status = "error";
            node.primary.error = ev.error;
          }
          if (!node.fallback) node.status = "error";
        } else if (ev.status === "fallback") {
          node.primary.status = "error";
          node.primary.error = ev.error;
          node.fallback = {
            resource: ev.resource,
            status: "active",
            priceUsdc: ev.priceUsdc,
          };
          node.status = "fallback";
        }
        break;
      }

      case "result":
        s.verdict.status = "ok";
        s.verdict.label = ev.payload.verdict.verdict;
        // Reconcile the live meter to the final grand total so the header
        // matches the card's "Total spent" (x402 + AI model calls). A cache
        // hit spent nothing this run, so the meter reads $0.
        if (ev.payload.fromCache) {
          s.spentUsdc = 0;
        } else if (ev.payload.totalSpentUsdc != null) {
          s.spentUsdc = ev.payload.totalSpentUsdc +
            (ev.payload.totalLlmCostUsd ?? 0);
        }
        if (s.synthesize === "active") s.synthesize = "ok";
        break;

      case "error":
        if (activePhase === "synthesize") s.synthesize = "error";
        else if (activePhase === "invoke") {
          // Mark any still-active category as error.
          for (const cat of s.categoryOrder) {
            const node = s.categories[cat];
            if (node && node.status === "active") node.status = "error";
          }
        } else if (activePhase === "discover") s.origin = "error";
        if (s.verdict.status === "idle") s.verdict.status = "error";
        break;

      case "log":
        // No flow state change from log events.
        break;
    }
  }

  return s;
}

export function useFlowState(events: VerifyEvent[]): FlowState {
  return useMemo(() => deriveFlowState(events), [events]);
}
