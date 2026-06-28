/** Canonical USD formatter shared across the UI. `undefined` renders as an
 * em-dash so cards/log/flow all agree on missing-value display (previously each
 * component defined its own variant, and the flow diagram rounded differently). */
export function fmtUsd(v?: number): string {
  return v == null ? "—" : `$${v.toFixed(4)}`;
}
