import type { CSSProperties } from "react";
import type { VerdictLabel, VerifyReceipt, VerifyResultPayload } from "../types";
import { WardoMascot, type WardoVariant } from "./WardoMascot";
import { CATEGORY_HINTS } from "../categoryLabels";

interface Props {
  result: VerifyResultPayload;
}

function fmtUsd(v?: number): string {
  return v == null ? "—" : `$${v.toFixed(4)}`;
}

function labelClass(v: VerdictLabel): string {
  if (v === "safe_to_transact") return "safe";
  if (v === "do_not_transact") return "risky";
  return "insufficient_data";
}

function mascotVariant(cls: string): WardoVariant {
  if (cls === "safe") return "safe";
  if (cls === "risky") return "villain";
  return "neutral";
}

function labelText(v: VerdictLabel): string {
  return v.split("_").join(" ");
}

function adapterBadgeStyle(path: VerifyReceipt["adapterPath"]): CSSProperties {
  // Three visual tiers: pattern = neutral (the happy default), pattern+subpath
  // = accent (recovered via descriptor retry), llm = warning (fell back to
  // LLM-built call — operationally interesting).
  const base: CSSProperties = {
    fontSize: 10,
    padding: "1px 5px",
    marginLeft: 6,
    border: "1px solid var(--faint)",
    borderRadius: 3,
    textTransform: "lowercase",
    whiteSpace: "nowrap",
  };
  if (path === "pattern+subpath") {
    return { ...base, borderColor: "var(--accent, #5aa)", color: "var(--accent, #5aa)" };
  }
  if (path === "llm") {
    return { ...base, borderColor: "var(--warn, #c80)", color: "var(--warn, #c80)" };
  }
  return { ...base, color: "var(--muted, #888)" };
}

export function VerdictCard({ result }: Props) {
  const { verdict, receipts, totalSpentUsdc, walletNetwork, synthesisError } = result;
  const cls = labelClass(verdict.verdict);
  return (
    <div className="card verdict-card" data-testid="verdict-card">
      <div className="card-header verdict-card-header">
        <div className="verdict-card-title">
          <h3>Verdict</h3>
          <span className="muted">
            {walletNetwork} · confidence {verdict.confidence}
          </span>
        </div>
        <WardoMascot variant={mascotVariant(cls)} size={64} className="verdict-mascot" />
      </div>

      {synthesisError && (
        <div className="synth-err" data-testid="synth-error">
          synthesis failed → stub verdict: {synthesisError}
        </div>
      )}

      <div className={`label ${cls}`} data-testid="verdict-label">
        {labelText(verdict.verdict)}
      </div>
      <div className="headline" data-testid="verdict-headline">{verdict.headline}</div>
      <div className="reasoning">{verdict.reasoning}</div>

      {verdict.findings.length > 0 && (
        <div style={{ marginTop: 14, fontSize: 12 }}>
          {verdict.findings.map((f, i) => (
            <div key={i} className="svc-row" style={{ gridTemplateColumns: "140px 80px 1fr" }}>
              <span className="cat" title={CATEGORY_HINTS[f.category]}>
                {f.category}
              </span>
              <span className="resource">{f.severity}</span>
              <span>{f.finding}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        {receipts.map((r) => (
          <div className="svc-row" key={`${r.category}-${r.resource}`}>
            <span className="cat" title={CATEGORY_HINTS[r.category]}>
              {r.category}
            </span>
            <span className="resource" title={r.error ?? ""}>
              {r.resource}
              {r.adapterPath && (
                <span
                  data-testid="adapter-badge"
                  style={adapterBadgeStyle(r.adapterPath)}
                >
                  {r.adapterPath}
                </span>
              )}
              {r.error && <span style={{ color: "var(--risk)" }}> · {r.error}</span>}
            </span>
            <span className="price">
              {r.status === "ok"
                ? `${fmtUsd(r.amountUsdc)} · ${r.durationMs ?? "?"}ms`
                : r.status}
            </span>
          </div>
        ))}
      </div>

      <div className="total">
        <span>Total spent</span>
        <span>{fmtUsd(totalSpentUsdc)}</span>
      </div>
    </div>
  );
}
