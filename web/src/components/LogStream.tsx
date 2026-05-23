import { useEffect, useRef } from "react";
import type { VerifyEvent } from "../types";

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

function fmtUsd(v?: number): string {
  return v == null ? "—" : `$${v.toFixed(4)}`;
}

function renderEvent(e: VerifyEvent): { cls: string; tag: string; text: string } {
  switch (e.type) {
    case "phase":
      return { cls: "phase", tag: `phase/${e.phase}`, text: e.status };
    case "log":
      return { cls: e.level, tag: e.level, text: e.message };
    case "service":
      return {
        cls: "service",
        tag: `service/${e.status}`,
        text:
          `· ${e.category} · ${e.resource} ` +
          (e.status === "ok"
            ? `· paid ${fmtUsd(e.amountUsdc)} · ${e.durationMs ?? "?"}ms`
            : e.status === "start"
            ? `· est ${fmtUsd(e.priceUsdc)}`
            : e.status === "error" || e.status === "fallback"
            ? `· ${e.error ?? ""}`
            : ""),
      };
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
