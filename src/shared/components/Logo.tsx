// The product mark: a rounded badge holding two opposed arrows — a request
// going out and a response coming back. It has to stay legible at 16px in the
// title bar and at 512px as the application icon, so it is deliberately built
// from three thick strokes and nothing else.

interface Props {
  size?: number;
  /** Draws the badge behind the arrows; off for tight spaces like the tray. */
  filled?: boolean;
  className?: string;
}

export function LogoMark({ size = 20, filled = true, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden
    >
      {filled && (
        <rect
          width="32"
          height="32"
          rx="8"
          fill="var(--color-brand)"
        />
      )}
      <g
        stroke={filled ? "#fff" : "var(--color-brand)"}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Request: out to the right. */}
        <path d="M8 12h13" />
        <path d="M17.5 8.5 21 12l-3.5 3.5" />
        {/* Response: back to the left. */}
        <path d="M24 20H11" />
        <path d="M14.5 16.5 11 20l3.5 3.5" />
      </g>
    </svg>
  );
}

interface WordmarkProps {
  size?: number;
  /** Smaller line under the name, e.g. on the splash. */
  tagline?: string;
  className?: string;
}

/** Mark plus product name, used in the title bar, splash and welcome screen. */
export function Logo({ size = 20, tagline, className }: WordmarkProps) {
  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      <LogoMark size={size} />
      <div className="leading-tight">
        <div
          className="font-semibold tracking-tight text-ink"
          style={{ fontSize: size * 0.7 }}
        >
          APIKit
        </div>
        {tagline && (
          <div className="text-xs text-muted">{tagline}</div>
        )}
      </div>
    </div>
  );
}
