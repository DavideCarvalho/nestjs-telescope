/**
 * Shared dark theme tokens for the Recharts chart cards. Centralizing these keeps
 * the chart layer consistent with the dashboard's zinc/emerald palette and makes
 * the rest of the app chart-library-agnostic (only this folder imports Recharts).
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

export const ACCENT_HEX = '#34d399'; // emerald-400 — primary throughput accent

export function hexForType(type: string, fallbackIndex = 0): string {
  const fallback = FALLBACK_PALETTE[fallbackIndex % FALLBACK_PALETTE.length];
  return TYPE_HEX[type] ?? fallback ?? '#71717a';
}

export const chartTheme = {
  gridStroke: '#ffffff10',
  axisStroke: '#3f3f46', // zinc-700
  axisTick: '#71717a', // zinc-500
  tooltipBg: '#18181b', // zinc-900
  tooltipBorder: '#27272a', // zinc-800
  tooltipText: '#e4e4e7', // zinc-200
  tooltipLabel: '#a1a1aa', // zinc-400
  legendText: '#a1a1aa', // zinc-400
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
