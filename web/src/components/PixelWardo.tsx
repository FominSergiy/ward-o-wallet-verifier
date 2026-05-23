import "./PixelWardo.css";

interface Props {
  active: boolean;
}

export function PixelWardo({ active }: Props) {
  return (
    <div className="pixel-wardo" data-testid="pixel-wardo" data-active={active}>
      <div
        className={active ? "pixel-wardo-sprite walking" : "pixel-wardo-sprite idle"}
        role="img"
        aria-label={active ? "Ward-o working" : "Ward-o idle"}
      />
      <div className="pixel-wardo-caption">
        {active ? "ward-o is working..." : "ward-o standing by"}
      </div>
    </div>
  );
}
