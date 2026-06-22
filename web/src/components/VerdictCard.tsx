import type { CSSProperties } from "react";
import type { VerdictLabel, VerifyReceipt, VerifyResultPayload } from "../types";
import { WardoMascot, type WardoVariant } from "./WardoMascot";
import { CATEGORY_HINTS } from "../categoryLabels";

interface Props {
  result: VerifyResultPayload;
  // When the fast tier returns needs_deep_check, the card renders an opt-in CTA
  // that calls this to run the paid deep check.
  onDeepCheck?: () => void;
  deepCheckBusy?: boolean;
}

function fmtUsd(v?: number): string {
  return v == null ? "—" : `$${v.toFixed(4)}`;
}

// Human label for a receipt's outcome. A best-effort category (e.g.
// web_sentiment) that failed reads as a non-blocking skip, not an error; a
// rate-limited call reads honestly instead of as a misleading "timeout".
function receiptStatusLabel(r: VerifyReceipt): string {
  if (r.status === "ok") return `${fmtUsd(r.amountUsdc)} · ${r.durationMs ?? "?"}ms`;
  if (r.bestEffort) return "skipped · best-effort";
  if (r.errorCode === "rate_limited") return "rate-limited";
  return r.status;
}

function receiptErrorText(r: VerifyReceipt): string | null {
  if (r.status === "ok") return null;
  if (r.bestEffort) return "best-effort · non-blocking";
  if (r.errorCode === "rate_limited") return "rate-limited";
  return r.error ?? null;
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

const sectionHeaderStyle: CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 6,
};

export function VerdictCard({ result, onDeepCheck, deepCheckBusy }: Props) {
  const {
    verdict,
    receipts,
    totalSpentUsdc,
    totalLlmCostUsd,
    walletNetwork,
    synthesisError,
    tier,
    fastSignal,
    fromCache,
  } = result;
  const grandTotalUsdc = totalSpentUsdc + (totalLlmCostUsd ?? 0);
  const cls = labelClass(verdict.verdict);
  const isFast = tier === "fast";
  const needsDeep = fastSignal === "needs_deep_check";
  return (
    <div className="card verdict-card" data-testid="verdict-card">
      <div className="card-header verdict-card-header">
        <div className="verdict-card-title">
          <h3>Verdict</h3>
          <span className="muted">
            {walletNetwork} · confidence {verdict.confidence}
            {" · "}
            <span
              className="tier-tag"
              data-testid="tier-badge"
              title={isFast
                ? "Free sanctions gate — no spend"
                : "Full paid pipeline"}
            >
              {isFast ? "fast tier" : "deep tier"}
            </span>
          </span>
        </div>
        <WardoMascot variant={mascotVariant(cls)} size={64} className="verdict-mascot" />
      </div>

      {synthesisError && (
        <div className="synth-err" data-testid="synth-error">
          synthesis failed → stub verdict: {synthesisError}
        </div>
      )}

      <div className="muted" style={sectionHeaderStyle}>Summary</div>
      <div className={`label ${cls}`} data-testid="verdict-label">
        {labelText(verdict.verdict)}
      </div>
      <div className="headline" data-testid="verdict-headline">{verdict.headline}</div>
      <div className="reasoning">{verdict.reasoning}</div>

      {verdict.findings.length > 0 && (
        <div style={{ marginTop: 18, fontSize: 12 }}>
          <div className="muted" style={sectionHeaderStyle}>Category findings</div>
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

      {isFast
        ? (
          <>
            <div className="total" data-testid="fast-no-spend">
              <span>Total spent</span>
              <span>{fmtUsd(0)} · fast tier</span>
            </div>
            {needsDeep && onDeepCheck && (
              <div className="deep-check-cta" data-testid="deep-check-cta">
                <button
                  type="button"
                  className="deep-check-btn"
                  onClick={onDeepCheck}
                  disabled={deepCheckBusy}
                  data-testid="deep-check-btn"
                >
                  {deepCheckBusy
                    ? "running deep check…"
                    : "Run deep check · ~$0.03"}
                </button>
                <p className="deep-check-note">
                  Fast tier found no blocking signal. The paid deep check adds
                  labels, on-chain history, sentiment &amp; AI synthesis for a
                  final verdict.
                </p>
              </div>
            )}
          </>
        )
        : (
          <>
      <div style={{ marginTop: 22 }}>
        <div className="muted" style={sectionHeaderStyle}>Paid services breakdown</div>
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
              {receiptErrorText(r) && (
                <span
                  style={{ color: r.bestEffort ? "var(--muted, #888)" : "var(--risk)" }}
                >
                  {" · "}
                  {receiptErrorText(r)}
                </span>
              )}
            </span>
            <span className="price">{receiptStatusLabel(r)}</span>
          </div>
        ))}
      </div>

      <div className="cost-subtotal" data-testid="cost-x402">
        <span>x402 services</span>
        <span>{fmtUsd(totalSpentUsdc)}</span>
      </div>
      <div className="cost-subtotal" data-testid="cost-llm">
        <span>AI model calls</span>
        <span>{fmtUsd(totalLlmCostUsd)}</span>
      </div>

      <div className="total">
        <span>{fromCache ? "Original cost" : "Total spent"}</span>
        <span>{fmtUsd(grandTotalUsdc)}</span>
      </div>
      {fromCache && (
        <div
          className="muted cache-note"
          data-testid="cache-note"
          style={{ fontSize: 11, marginTop: 4 }}
        >
          served from cache · $0 charged this run
        </div>
      )}
          </>
        )}
    </div>
  );
}
