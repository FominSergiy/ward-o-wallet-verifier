import { useState } from "react";
import type { PlanView } from "../types";

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
          <span className="cat">{s.category}</span>
          <span className="resource" title={s.rationale}>{s.resource}</span>
          <span className="price">{fmtUsd(s.priceUsdc)}</span>
        </div>
      ))}

      <div className="total">
        <span>Total estimated</span>
        <span>{fmtUsd(plan.totalEstimatedCostUsdc)}</span>
      </div>
    </div>
  );
}
