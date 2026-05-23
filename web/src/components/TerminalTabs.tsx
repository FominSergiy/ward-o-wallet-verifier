import { useState } from "react";
import type { VerifyEvent } from "../types";
import { LogStream } from "./LogStream";
import { FlowDiagram } from "./FlowDiagram";

export type TabId = "plan" | "verify";
type View = "logs" | "flow";

interface Props {
  active: TabId;
  onChange: (id: TabId) => void;
  planEvents: VerifyEvent[];
  verifyEvents: VerifyEvent[];
  planStreaming: boolean;
  verifyStreaming: boolean;
}

export function TerminalTabs(props: Props) {
  const { active, onChange, planEvents, verifyEvents, planStreaming, verifyStreaming } = props;
  const [view, setView] = useState<View>("flow");
  const events = active === "plan" ? planEvents : verifyEvents;
  return (
    <div className="terminal-tabs" data-testid="terminal-tabs">
      <div className="tab-strip with-toggle">
        <button
          type="button"
          className={`tab ${active === "plan" ? "active" : ""}`}
          onClick={() => onChange("plan")}
          data-testid="tab-plan"
        >
          plan
          <span className="count">{planEvents.length}</span>
          {planStreaming && <span className="dot" />}
        </button>
        <button
          type="button"
          className={`tab ${active === "verify" ? "active" : ""}`}
          onClick={() => onChange("verify")}
          data-testid="tab-verify"
        >
          execute
          <span className="count">{verifyEvents.length}</span>
          {verifyStreaming && <span className="dot" />}
        </button>
        <div className="view-toggle" data-testid="view-toggle">
          <button
            type="button"
            className={view === "logs" ? "active" : ""}
            onClick={() => setView("logs")}
            data-testid="view-logs"
          >
            logs
          </button>
          <button
            type="button"
            className={view === "flow" ? "active" : ""}
            onClick={() => setView("flow")}
            data-testid="view-flow"
          >
            flow
          </button>
        </div>
      </div>
      {view === "flow" ? (
        <FlowDiagram events={events} />
      ) : (
        <LogStream events={events} />
      )}
    </div>
  );
}
