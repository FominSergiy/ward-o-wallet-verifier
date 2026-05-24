import { useState } from "react";
import type { PlanView } from "../types";
import { CATEGORY_HINTS } from "../categoryLabels";

interface Props {
  plan: PlanView;
  onSave: () => void;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(4)}`;
}

export function PlanCard({ plan, onSave }: Props) {
  const [saved, setSaved] = useState(false);

  function handleSave() {
    onSave();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="card plan-card" data-testid="plan-card">
      <div className="card-header">
        <h3>
          Plan
          <button
            type="button"
            onClick={handleSave}
            style={{
              marginLeft: 12,
              fontSize: 11,
              padding: "4px 10px",
              border: "1px solid var(--faint)",
              background: "var(--bg)",
              cursor: "pointer",
            }}
            data-testid="save-plan-btn"
          >
            Save
          </button>
          {saved && <span className="saved-tag">saved ✓</span>}
        </h3>
        <span className="muted">
          {plan.walletNetwork}
          {plan.unresolvedCategories.length > 0 &&
            ` · unresolved: ${plan.unresolvedCategories.join(", ")}`}
        </span>
      </div>

      {plan.services.map((s) => (
        <div className="svc-row" key={`${s.category}-${s.resource}`}>
          <span className="cat" title={CATEGORY_HINTS[s.category]}>
            {s.category}
          </span>
          <span className="resource" title={s.rationale}>{s.resource}</span>
          <span className="price">{fmtUsd(s.priceUsdc)}</span>
        </div>
      ))}

      {plan.deterministicSources.length > 0 && (
        <div
          data-testid="deterministic-sources"
          style={{
            marginTop: 22,
            paddingTop: 14,
            borderTop: "1px dashed var(--faint)",
          }}
        >
          <div
            className="muted"
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              marginBottom: 6,
            }}
          >
            Always-on free checks
          </div>
          {plan.deterministicSources.map((s) => (
            <div
              className="svc-row"
              key={`free-${s.category}-${s.resource}`}
              data-testid="deterministic-row"
            >
              <span className="cat" title={CATEGORY_HINTS[s.category]}>
                {s.category}
              </span>
              <span className="resource" title={s.rationale}>{s.resource}</span>
              <span className="price">{fmtUsd(0)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="total">
        <span>Total estimated</span>
        <span>{fmtUsd(plan.totalEstimatedCostUsdc)}</span>
      </div>
    </div>
  );
}
