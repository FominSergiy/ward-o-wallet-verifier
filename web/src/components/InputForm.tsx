const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

interface Props {
  address: string;
  busy: boolean;
  running: boolean;
  onAddressChange: (v: string) => void;
  onPlan: () => void;
  onExecute: () => void;
}

export function InputForm(props: Props) {
  const { address, busy, running, onAddressChange, onPlan, onExecute } = props;
  const valid = ADDR_RE.test(address.trim());
  const disabled = busy || !valid;

  return (
    <div className="input-form" data-testid="input-form">
      <input
        type="text"
        placeholder="0x… wallet address"
        value={address}
        onChange={(e) => onAddressChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        data-testid="address-input"
      />
      <button
        type="button"
        className="secondary"
        disabled={disabled}
        onClick={onPlan}
        data-testid="plan-btn"
      >
        Plan
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onExecute}
        data-testid="execute-btn"
      >
        Execute
      </button>
      {running && <span className="pill running" data-testid="running-pill">running…</span>}
      {!valid && address.length > 0 && (
        <div className="hint">Address must match 0x + 40 hex characters. Non-EVM chains (Solana, Bitcoin, etc.) are not supported.</div>
      )}
    </div>
  );
}
