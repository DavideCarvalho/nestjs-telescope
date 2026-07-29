/**
 * Shared theme values for the Recharts chart cards. Only this folder imports
 * Recharts, so this is the one place chart colours are decided.
 *
 * Two palettes live here and they are NOT the same thing:
 *  - `TYPE_HEX` is CATEGORICAL: one hue per entry type, chosen to be mutually
 *    distinguishable. It is data, and deliberately does not go through the Aviary
 *    status tokens — a `request` series is not "healthy", it is just requests.
 *  - `chartTheme` / `ACCENT_HEX` is CHROME: grid, axes, tooltip, the throughput
 *    accent. Those follow the console tokens so they theme with everything else.
 *
 * Recharts takes plain colour strings rather than classes, so chrome reads the
 * tokens as `var(--x)`; SVG resolves the custom property at paint time.
 */

/** Resolved hex colors for known entry types (matches the `fill-*` tokens used elsewhere). */
export const TYPE_HEX: Record<string, string> = {
  request: '#34d399', // emerald-400
  query: '#38bdf8', // sky-400
  job: '#a78bfa', // violet-400
  exception: '#f87171', // red-400
  http_client: '#fbbf24', // amber-400
  mail: '#f472b6', // pink-400
};

/** Ordered palette for series whose type is not in {@link TYPE_HEX}. */
const FALLBACK_PALETTE = ['#71717a', '#a1a1aa', '#22d3ee', '#c084fc', '#fb923c', '#4ade80'];

/** Primary throughput accent — the console `--accent`, not a status hue. */
export const ACCENT_HEX = 'var(--accent)';

export function hexForType(type: string, fallbackIndex = 0): string {
  const fallback = FALLBACK_PALETTE[fallbackIndex % FALLBACK_PALETTE.length];
  return TYPE_HEX[type] ?? fallback ?? '#71717a';
}

export const chartTheme = {
  gridStroke: 'color-mix(in srgb, var(--line) 70%, transparent)',
  axisStroke: 'var(--line)',
  axisTick: 'var(--muted)',
  tooltipBg: 'var(--panel-2)',
  tooltipBorder: 'var(--line)',
  tooltipText: 'var(--text)',
  tooltipLabel: 'var(--muted)',
  legendText: 'var(--muted)',
} as const;

/** Shared `contentStyle` for Recharts `<Tooltip>` so every chart looks identical. */
export const tooltipContentStyle = {
  background: chartTheme.tooltipBg,
  border: `1px solid ${chartTheme.tooltipBorder}`,
  borderRadius: 6,
  fontSize: 11,
  color: chartTheme.tooltipText,
} as const;

export const tooltipLabelStyle = {
  color: chartTheme.tooltipLabel,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
} as const;

export const tooltipItemStyle = {
  color: chartTheme.tooltipText,
} as const;

export const axisTickStyle = {
  fill: chartTheme.axisTick,
  fontSize: 10,
} as const;
