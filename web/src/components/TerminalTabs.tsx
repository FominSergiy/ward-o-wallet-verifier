import type { VerifyEvent } from "../types";
import { LogStream } from "./LogStream";

export type TabId = "plan" | "verify";

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
  const events = active === "plan" ? planEvents : verifyEvents;
  return (
    <div className="terminal-tabs" data-testid="terminal-tabs">
      <div className="tab-strip">
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
      </div>
      <LogStream events={events} />
    </div>
  );
}
