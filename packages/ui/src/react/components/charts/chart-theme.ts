import type { ChartConfig } from '../../ui/chart.js';

/**
 * Series colours for the chart cards. This file is the ONE place a chart decides
 * what colour a series is; the chrome around it (grid, axes, tick text, brush,
 * tooltip, legend) belongs to the vendored `ChartContainer` in `../../ui/chart.tsx`.
 *
 * That split is the point. Colours here are DATA — one hue per entry type, chosen
 * to be mutually distinguishable — and deliberately do not go through the Aviary
 * status tokens: a `request` series is not "healthy", it is just requests (see
 * AVIARY-UI.md, "Categorical data hues are not tokens"). Chrome does follow the
 * tokens, so it themes with the rest of the console.
 *
 * Recharts takes plain colour strings rather than classes, so anything token-based
 * reads as `var(--x)`; SVG resolves the custom property at paint time.
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

/**
 * Ordered palette for breakdown segments, which are usually an outcome split
 * (ok / retried / failed) rather than a set of entry types — so it opens on the
 * good/warn/bad progression instead of {@link FALLBACK_PALETTE}'s neutrals.
 */
const SEGMENT_PALETTE = ['#34d399', '#fbbf24', '#f87171', '#38bdf8', '#a78bfa'];

/** Primary throughput accent — the console `--accent`, not a status hue. */
export const ACCENT_HEX = 'var(--aviary-accent-ink, var(--accent))';

export function hexForType(type: string, fallbackIndex = 0): string {
  const fallback = FALLBACK_PALETTE[fallbackIndex % FALLBACK_PALETTE.length];
  return TYPE_HEX[type] ?? fallback ?? '#71717a';
}

/**
 * Colour for one breakdown/pie segment: an author's explicit `color` wins, then
 * the entry-type hue when the segment is named after a known type, then the
 * palette by position.
 *
 * The {@link TYPE_HEX} step is why this is not just an array index: a breakdown
 * of `request`/`query`/`exception` used to draw them green/amber/red purely by
 * position, so the same `exception` was red in one card and amber in the next.
 */
export function hexForSegment(label: string, index: number, override?: string): string {
  if (override) return override;
  const palette = SEGMENT_PALETTE[index % SEGMENT_PALETTE.length];
  return TYPE_HEX[label] ?? palette ?? '#71717a';
}

/**
 * Build a {@link ChartConfig} for a set of series keys. Every card goes through
 * here so the tooltip, the legend and the marks all read the same colour from the
 * same place — the shadcn chart layer resolves labels and swatches from the
 * config, and a colour passed straight to a `<Bar>` would leave both blank.
 */
export function chartConfig(
  keys: string[],
  colorFor: (key: string, index: number) => string,
  labelFor?: (key: string) => string,
): ChartConfig {
  const config: ChartConfig = {};
  keys.forEach((key, index) => {
    config[key] = { label: labelFor?.(key) ?? key, color: colorFor(key, index) };
  });
  return config;
}
