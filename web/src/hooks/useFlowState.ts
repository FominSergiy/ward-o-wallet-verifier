import { useMemo } from "react";
import type { Category, VerifyEvent, VerdictLabel } from "../types";

export type NodeStatus = "idle" | "active" | "ok" | "error" | "fallback";

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
    };
    if (!state.categoryOrder.includes(cat)) state.categoryOrder.push(cat);
  }
  return state.categories[cat];
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
          if (ev.phase === "synthesize" && s.synthesize === "active") s.synthesize = "ok";
          if (ev.phase === "invoke") {
            // Cascade any leftover idle categories — they were skipped silently.
            // Any sub-node still "active" at invoke-end means the attempt
            // ended without resolution; treat it as an error.
            for (const cat of s.categoryOrder) {
              const node = s.categories[cat];
              if (!node) continue;
              if (node.status === "idle") node.status = "ok";
              if (node.primary.status === "active") node.primary.status = "error";
              if (node.fallback?.status === "active") node.fallback.status = "error";
              if (node.status === "active") node.status = "error";
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
        const isFallbackAttempt =
          node.primary.resource !== "" && node.primary.resource !== ev.resource;

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
        if (ev.payload.totalSpentUsdc != null) s.spentUsdc = ev.payload.totalSpentUsdc;
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
