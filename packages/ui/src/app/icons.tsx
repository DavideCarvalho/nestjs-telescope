import type { SVGProps } from 'react';

/**
 * The telescope console's own 16px nav glyphs, drawn like the kit's (`aviary-kit/icons.tsx`):
 * stroke paths in currentColor on a 16×16 grid.
 */
type IconProps = SVGProps<SVGSVGElement>;

function Glyph({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Pulse: a heartbeat line. */
export function PulseIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M1.5 8.5h2.5l1.5-3 2.5 6 2-4.5 1 1.5h3.5" />
    </Glyph>
  );
}

/** Traces: a waterfall of spans. */
export function TraceIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M2 3.5h7M4 6.5h7M6 9.5h5M8 12.5h6" />
    </Glyph>
  );
}

/** AI: a four-point spark. */
export function AiIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 1.5c.5 3 1.5 4 4.5 4.5-3 .5-4 1.5-4.5 4.5-.5-3-1.5-4-4.5-4.5 3-.5 4-1.5 4.5-4.5z" />
      <path d="M12.5 10.5v3M11 12h3" />
    </Glyph>
  );
}

/** Profiles: a flame graph's stacked bars. */
export function FlameIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="1.5" y="11" width="13" height="2.5" rx="0.6" />
      <rect x="2.5" y="7.5" width="7" height="2.5" rx="0.6" />
      <rect x="10.5" y="7.5" width="3" height="2.5" rx="0.6" />
      <rect x="3.5" y="4" width="4" height="2.5" rx="0.6" />
    </Glyph>
  );
}

/** Exports: an arrow into a tray. */
export function DownloadIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 11v2.5h11V11" />
    </Glyph>
  );
}

/** Prunes: a bin. */
export function TrashIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" />
    </Glyph>
  );
}

/** A contributed dashboard: a chart in a frame. */
export function DashboardIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="1.5" y="2" width="13" height="12" rx="2" />
      <path d="M4.5 11V8.5M8 11V5.5M11.5 11V7" />
    </Glyph>
  );
}
