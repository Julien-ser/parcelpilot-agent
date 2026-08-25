/**
 * The ParcelPilot mark.
 *
 * A parcel seen from directly above (the outer diamond) with a compass needle
 * set inside it. Two readings of the same name in one shape, and it survives
 * being shrunk to a 16px favicon because it is only two closed paths.
 */
export function LogoMark({
  size = 26,
  className,
  style,
}: {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M16 4.25 L27.75 16 L16 27.75 L4.25 16 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        opacity={0.55}
      />
      <path d="M16 9 L20.75 16 L16 19.75 L11.25 16 Z" fill="var(--accent)" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className} style={{ letterSpacing: "-0.022em" }}>
      <span style={{ fontWeight: 500 }}>Parcel</span>
      <span style={{ fontWeight: 700 }}>Pilot</span>
    </span>
  );
}

export function Logo({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark className="shrink-0" style={{ color: "var(--text)" }} />
      <div className="leading-none">
        <Wordmark className="text-[15px] block" />
        {subtitle ? (
          <span
            className="mono block mt-1 text-[10.5px] uppercase"
            style={{ color: "var(--muted)", letterSpacing: "0.08em" }}
          >
            {subtitle}
          </span>
        ) : null}
      </div>
    </div>
  );
}
