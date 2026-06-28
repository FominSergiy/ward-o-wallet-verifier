import { useEffect, useRef } from "react";
import type { VerifyEvent } from "../types";
import { fmtUsd } from "../utils";

interface Props {
  events: VerifyEvent[];
}

function ts(at: string): string {
  try {
    const d = new Date(at);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return at;
  }
}

function renderEvent(e: VerifyEvent): { cls: string; tag: string; text: string } {
  switch (e.type) {
    case "phase":
      return { cls: "phase", tag: `phase/${e.phase}`, text: e.status };
    case "log":
      return { cls: e.level, tag: e.level, text: e.message };
    case "service": {
      // Direct paths (Chainalysis oracle, ENS resolver, viem fallback) are
      // free chain primitives — rendering them with "paid $0.0000" looks like
      // a failure. Use "resolved" so the log line reads as a success signal.
      const isDirect = e.kind === "direct";
      const okSuffix = isDirect
        ? `· resolved · ${e.durationMs ?? "?"}ms`
        : `· paid ${fmtUsd(e.amountUsdc)} · ${e.durationMs ?? "?"}ms`;
      const startSuffix = isDirect ? "· free" : `· est ${fmtUsd(e.priceUsdc)}`;
      return {
        cls: "service",
        tag: `service/${e.status}`,
        text:
          `· ${e.category} · ${e.resource} ` +
          (e.status === "ok"
            ? okSuffix
            : e.status === "start"
            ? startSuffix
            : e.status === "error" || e.status === "fallback"
            ? `· ${e.error ?? ""}`
            : ""),
      };
    }
    case "plan":
      return {
        cls: "plan",
        tag: "plan",
        text: `${e.services.length} services · est ${fmtUsd(e.totalEstimatedCostUsdc)} · ${e.walletNetwork}`,
      };
    case "result":
      return { cls: "result", tag: "result", text: "verdict received" };
    case "error":
      return { cls: "error", tag: `error/${e.code}`, text: e.message };
  }
}

export function LogStream({ events }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events]);

  return (
    <div className="log-stream" ref={ref} data-testid="log-stream">
      {events.length === 0 && (
        <span className="log-line" style={{ color: "#8A8888" }}>waiting for events…</span>
      )}
      {events.map((e, i) => {
        const r = renderEvent(e);
        return (
          <span key={i} className={`log-line ${r.cls}`}>
            <span className="ts">{ts(e.at)}</span>
            <span className="tag">[{r.tag}]</span>
            {r.text}
          </span>
        );
      })}
    </div>
  );
}
