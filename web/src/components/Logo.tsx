import { WardoMascot } from "./WardoMascot";

export function Logo() {
  return (
    <div className="logo-row">
      <div className="logo-text">
        <div className="logo">WARD-o</div>
        <div className="tagline">wallet risk verification, on demand.</div>
      </div>
      <WardoMascot variant="neutral" size={88} className="logo-mascot" />
    </div>
  );
}
