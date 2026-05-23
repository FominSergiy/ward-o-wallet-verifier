import type { VerdictLabel, VerifyResultPayload } from "../types";
import { WardoMascot, type WardoVariant } from "./WardoMascot";

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
              <span className="cat">{f.category}</span>
              <span className="resource">{f.severity}</span>
              <span>{f.finding}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        {receipts.map((r) => (
          <div className="svc-row" key={`${r.category}-${r.resource}`}>
            <span className="cat">{r.category}</span>
            <span className="resource" title={r.error ?? ""}>
              {r.resource}
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
