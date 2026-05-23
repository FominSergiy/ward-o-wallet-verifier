export type WardoVariant = "neutral" | "safe" | "villain";

interface Props {
  variant: WardoVariant;
  size?: number;
  className?: string;
}

const SRC: Record<WardoVariant, string> = {
  neutral: "/wardo/wardo-neutral.svg",
  safe: "/wardo/wardo-safe.svg",
  villain: "/wardo/wardo-villain.svg",
};

const ALT: Record<WardoVariant, string> = {
  neutral: "Ward-o",
  safe: "Ward-o (safe)",
  villain: "Ward-o (risky)",
};

export function WardoMascot({ variant, size = 72, className }: Props) {
  return (
    <img
      src={SRC[variant]}
      alt={ALT[variant]}
      width={size}
      height={size}
      className={className ? `wardo ${className}` : "wardo"}
      data-variant={variant}
    />
  );
}
