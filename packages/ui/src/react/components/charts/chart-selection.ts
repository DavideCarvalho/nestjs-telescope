/**
 * What a user clicked inside a chart, in the one shape every card reports it.
 *
 * This is the drill-down intent and nothing more: a card knows what was clicked,
 * it does not know what that should filter. The caller decides — `PanelView`
 * forwards the selection, the extension dashboard turns it into provider query
 * state. Keeping the card ignorant is what lets the same `AreaChartCard` sit on
 * the Overview page (where clicking means nothing and no callback is passed) and
 * on an extension dashboard (where it filters the page).
 */
export interface ChartSelection {
  /** The category, bucket or x-axis label under the click. */
  label: string;
  /** Series key when the chart draws more than one; absent for single-series charts. */
  series?: string;
  /** Provider-supplied stable id, when the datum carried one (topN items do). */
  id?: string;
  /** The value at the click, when the click resolved to a single datum. */
  value?: number;
}

/**
 * Build a {@link ChartSelection} without tripping `exactOptionalPropertyTypes`,
 * which rejects an explicit `undefined` for an optional field. Every card builds
 * its selection here so "no id" is consistently an absent key rather than a
 * present `undefined` — the difference shows up the moment a selection is spread
 * into a query object.
 */
export function chartSelection(input: {
  label: string;
  series?: string | undefined;
  id?: string | undefined;
  value?: number | undefined;
}): ChartSelection {
  return {
    label: input.label,
    ...(input.series !== undefined ? { series: input.series } : {}),
    ...(input.id !== undefined ? { id: input.id } : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The x-axis label under a click on a cartesian chart.
 *
 * A click on an area or a line has no single datum — Recharts reports the whole
 * hovered category in its chart-level event state instead, and types that state
 * loosely enough that reading it is a runtime question, not a compile-time one.
 * Returns undefined when the click landed on chrome (axis, legend, padding),
 * which is the case a drill-down must ignore rather than fire an empty filter.
 */
export function activeChartLabel(state: unknown): string | undefined {
  if (!isRecord(state)) return undefined;
  const label = state.activeLabel;
  if (typeof label === 'string' && label.length > 0) return label;
  return typeof label === 'number' ? String(label) : undefined;
}
