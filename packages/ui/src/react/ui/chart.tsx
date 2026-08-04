import type { CSSProperties, JSX, ReactElement, ReactNode } from 'react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Legend, ResponsiveContainer, Tooltip } from 'recharts';
import { Button } from './button.js';
import { cn } from './cn.js';

/**
 * Vendored shadcn `Chart` layer, retuned to the Aviary tokens.
 *
 * Same shape as the other primitives in this folder: shadcn source adapted to the
 * console palette rather than shadcn's default CSS variables. Two deliberate
 * departures from upstream, both because upstream is solving a problem this
 * console does not have:
 *
 *  1. **No injected `<style>` tag.** shadcn's `ChartStyle` writes a per-chart
 *     stylesheet through `dangerouslySetInnerHTML` so a config can carry one
 *     colour per theme. Our colours are already tokens (`var(--accent)`) or
 *     categorical hexes that mean the same thing in both themes, so the same
 *     `--color-<key>` custom properties are set inline on the container. That
 *     removes an HTML-injection-shaped API from a component whose config can
 *     come from an extension-authored dashboard spec.
 *  2. **Chart chrome is styled by class, not by props.** Grid, axis lines, tick
 *     text, brush and radial background are selected off Recharts' own class
 *     names on the container, so a card is `ChartContainer` + marks and does not
 *     restate six stroke colours. `chart-theme.ts` keeps the *data* colours; this
 *     file owns the chrome.
 *
 * INTERNAL, like the rest of `src/react/ui/` — see this folder's `index.ts` for
 * why the barrel is not re-exported from the package's public React surface.
 */

/** One series' presentation: what to call it and what colour to draw it. */
export interface ChartSeriesConfig {
  /** Human label shown in the tooltip and legend. Defaults to the series key. */
  label?: ReactNode;
  /** Any CSS colour — an Aviary token (`var(--accent)`) or a categorical hex. */
  color?: string;
}

/** Keyed by the series' `dataKey`, exactly as Recharts reports it back. */
export type ChartConfig = Record<string, ChartSeriesConfig>;

const ChartContext = createContext<ChartConfig | null>(null);

/**
 * The active chart's config. Recharts renders tooltip/legend content inside the
 * chart's own React subtree, so context reaches them even though they are handed
 * to Recharts as elements rather than rendered by the card directly.
 */
function useChartConfig(): ChartConfig {
  return useContext(ChartContext) ?? {};
}

/**
 * Recharts chrome, expressed against the Aviary tokens.
 *
 * These select Recharts' own class names because Recharts paints most chrome as
 * SVG presentation attributes (`stroke="#ccc"`), and a stylesheet rule beats a
 * presentation attribute — which is what lets one class list replace the stroke
 * props every card used to repeat.
 */
const CHART_CHROME = [
  'h-full w-full text-[10px]',
  '[&_.recharts-cartesian-grid_line]:stroke-line',
  '[&_.recharts-cartesian-axis-line]:stroke-line',
  '[&_.recharts-cartesian-axis-tick-line]:stroke-line',
  '[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground',
  '[&_.recharts-radial-bar-background-sector]:fill-panel-2',
  '[&_.recharts-reference-line_line]:stroke-line',
  '[&_.recharts-brush-texts_text]:fill-muted-foreground',
  '[&_.recharts-sector]:outline-none',
  '[&_.recharts-layer]:outline-none',
  '[&_.recharts-surface]:overflow-visible',
].join(' ');

/**
 * Props for a token-styled `<Brush>`. Exported as a props object rather than a
 * wrapper component on purpose: Recharts finds the brush by scanning its own
 * children for the `Brush` element type, so a wrapper compiles fine and then
 * silently renders nothing. Spread this onto a real `<Brush>`.
 */
export const chartBrushProps = {
  height: 18,
  travellerWidth: 8,
  // `stroke` colours the travellers and the outline; the accent makes the two
  // drag handles read as the interactive part of an otherwise static chart.
  stroke: 'var(--accent)',
  fill: 'color-mix(in srgb, var(--panel-2) 80%, transparent)',
} as const;

/**
 * Custom properties are not part of React's `CSSProperties`, so the container's
 * style object declares the one slot it actually sets. Typing it out is what lets
 * this file hand Recharts `var(--color-<key>)` without a cast.
 */
type ChartCssVars = Record<`--color-${string}`, string>;

function chartCssVars(config: ChartConfig): ChartCssVars {
  const vars: ChartCssVars = {};
  for (const [key, series] of Object.entries(config)) {
    if (series.color) vars[`--color-${key}`] = series.color;
  }
  return vars;
}

/** Reference a configured series' colour from inside a chart. */
export function chartColorVar(key: string): string {
  return `var(--color-${key})`;
}

/**
 * The framed chart body: publishes the config to tooltip/legend content, exposes
 * each series colour as a `--color-<key>` custom property, and sizes the chart to
 * its parent (the card's fixed-height body).
 */
export function ChartContainer({
  config,
  className,
  children,
}: {
  config: ChartConfig;
  className?: string;
  children: ReactElement;
}): JSX.Element {
  const style: CSSProperties & ChartCssVars = useMemo(() => chartCssVars(config), [config]);
  return (
    <ChartContext.Provider value={config}>
      <div data-chart="" className={cn(CHART_CHROME, className)} style={style}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

/** Recharts' own `Tooltip`, re-exported so the element type Recharts scans for is unchanged. */
export const ChartTooltip = Tooltip;

/** Recharts' own `Legend`, re-exported for the same reason as {@link ChartTooltip}. */
export const ChartLegend = Legend;

/**
 * Recharts hands tooltip and legend content whatever it happens to be carrying,
 * typed loosely on its side. Rather than trust a cast, everything read off a
 * payload item goes through these guards — a provider can return anything, and a
 * dashboard panel that renders `[object Object]` in a tooltip is a bug nobody
 * notices until a customer screenshots it.
 */
interface ChartPayloadItem {
  readonly [key: string]: unknown;
}

function isPayloadItem(value: unknown): value is ChartPayloadItem {
  return typeof value === 'object' && value !== null;
}

function payloadItems(payload: unknown): ChartPayloadItem[] {
  return Array.isArray(payload) ? payload.filter(isPayloadItem) : [];
}

/** A displayable string, or undefined when the value is not one. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Nested `payload.payload` is where Recharts keeps the original datum. */
function datumOf(item: ChartPayloadItem): ChartPayloadItem | undefined {
  return isPayloadItem(item.payload) ? item.payload : undefined;
}

/** The key a payload item is configured under: its `dataKey`, else its `name`. */
function seriesKey(item: ChartPayloadItem): string | undefined {
  return text(item.dataKey) ?? text(item.name);
}

/**
 * The same thing for a LEGEND payload, where `value` holds the series name rather
 * than a number. Pie sectors report only that — no `dataKey`, no `name` — so a
 * legend that reused {@link seriesKey} rendered a donut's entries blank and
 * un-clickable.
 */
function legendKey(item: ChartPayloadItem): string | undefined {
  return text(item.dataKey) ?? text(item.name) ?? text(item.value);
}

/**
 * React key for one tooltip/legend row. The series key is the row's identity;
 * position is the fallback for an entry that has none (a pie sector in a payload
 * Recharts rebuilds wholesale on every hover anyway, so nothing is preserved
 * across renders that reordering could corrupt).
 */
function rowKey(key: string | undefined, index: number): string {
  return key ?? `series-${index}`;
}

function seriesColor(
  item: ChartPayloadItem,
  key: string | undefined,
  config: ChartConfig,
): string | undefined {
  const configured = key ? config[key]?.color : undefined;
  // The datum's own colour comes first: a provider that colours a row (a topN
  // bar, a breakdown segment) means it, and Recharts reports the *series* colour
  // in `color`/`fill` — per-cell fills never reach it, so a donut of five hues
  // would otherwise draw five identical swatches.
  return text(datumOf(item)?.color) ?? configured ?? text(item.color) ?? text(item.fill);
}

function seriesLabel(
  item: ChartPayloadItem,
  key: string | undefined,
  config: ChartConfig,
): ReactNode {
  const configured = key ? config[key]?.label : undefined;
  return configured ?? text(item.name) ?? key ?? '';
}

export interface ChartTooltipContentProps {
  /** Injected by Recharts. */
  active?: boolean;
  /** Injected by Recharts: one entry per series under the cursor. */
  payload?: unknown;
  /** Injected by Recharts: the category/x value under the cursor. */
  label?: unknown;
  /** Hide the label row (single-value charts where the label repeats the series). */
  hideLabel?: boolean;
  /** Hide the colour swatch. */
  hideIndicator?: boolean;
  /** Format the label row — e.g. a bucket label into a duration. */
  labelFormatter?: (label: string) => ReactNode;
  /** Format each series value — e.g. a count into `1.2s`. */
  valueFormatter?: (value: number, key: string) => ReactNode;
  className?: string;
}

/**
 * The hover card: label row, then one row per series with its colour swatch,
 * configured name and formatted value. Replaces the three `contentStyle` /
 * `labelStyle` / `itemStyle` objects each card used to pass to Recharts, which
 * could only ever produce a single flat line of text.
 */
export function ChartTooltipContent({
  active,
  payload,
  label,
  hideLabel = false,
  hideIndicator = false,
  labelFormatter,
  valueFormatter,
  className,
}: ChartTooltipContentProps): JSX.Element | null {
  const config = useChartConfig();
  const items = payloadItems(payload);
  if (!active || items.length === 0) return null;

  const labelText = text(label);
  const labelNode = labelText === undefined ? null : (labelFormatter?.(labelText) ?? labelText);

  return (
    <div
      className={cn(
        'min-w-[8rem] rounded border border-line bg-popover px-2 py-1.5 text-[11px] text-popover-foreground shadow-lg',
        className,
      )}
    >
      {!hideLabel && labelNode !== null && (
        <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {labelNode}
        </p>
      )}
      <div className="grid gap-0.5">
        {items.map((item, index) => {
          const key = seriesKey(item);
          const value = numeric(item.value);
          const formatted =
            value !== undefined && valueFormatter
              ? valueFormatter(value, key ?? '')
              : (text(item.value) ?? '—');
          const color = seriesColor(item, key, config);
          return (
            <div key={rowKey(key, index)} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                {!hideIndicator && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-[2px] border border-line"
                    style={color ? { background: color } : undefined}
                  />
                )}
                {seriesLabel(item, key, config)}
              </span>
              <span className="font-mono tabular-nums text-foreground">{formatted}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface ChartLegendContentProps {
  /** Injected by Recharts: one entry per series. */
  payload?: unknown;
  /** Series keys currently hidden. Rendered dimmed and `aria-pressed={false}`. */
  hidden?: ReadonlySet<string>;
  /**
   * Called with a series key when its legend entry is activated. Presence of this
   * callback is what turns the legend from a caption into controls — without it
   * the entries stay plain text, because a `<button>` that does nothing is worse
   * for a screen reader than a label.
   */
  onToggle?: (key: string) => void;
  className?: string;
}

/** Legend row: a colour swatch + the configured label per series, optionally clickable. */
export function ChartLegendContent({
  payload,
  hidden,
  onToggle,
  className,
}: ChartLegendContentProps): JSX.Element | null {
  const config = useChartConfig();
  const items = payloadItems(payload);
  if (items.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-x-2 gap-y-1', className)}>
      {items.map((item, index) => {
        const key = legendKey(item);
        const isHidden = key !== undefined && hidden?.has(key) === true;
        const color = seriesColor(item, key, config);
        const swatch = (
          <span
            className="h-2 w-2 shrink-0 rounded-[2px]"
            style={color ? { background: color } : undefined}
          />
        );
        const label = seriesLabel(item, key, config);
        if (!onToggle || key === undefined) {
          return (
            <span
              key={rowKey(key, index)}
              className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground"
            >
              {swatch}
              {label}
            </span>
          );
        }
        return (
          <Button
            key={rowKey(key, index)}
            variant="ghost"
            size="xs"
            aria-pressed={!isHidden}
            title={isHidden ? `Show ${key}` : `Hide ${key}`}
            className={cn('gap-1.5 normal-case tracking-normal', isHidden && 'opacity-40')}
            onClick={() => onToggle(key)}
          >
            {swatch}
            {label}
          </Button>
        );
      })}
    </div>
  );
}

/** Hidden-series state for a chart with a clickable legend. */
export interface SeriesToggle {
  hidden: ReadonlySet<string>;
  toggle: (key: string) => void;
  isHidden: (key: string) => boolean;
}

/**
 * Which series a clickable legend has switched off. Kept as component state
 * rather than pushed up to the panel spec: hiding a series is a reading aid for
 * the person at the screen, not a property of the dashboard.
 */
export function useSeriesToggle(): SeriesToggle {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggle = useCallback((key: string) => {
    setHidden((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const isHidden = useCallback((key: string) => hidden.has(key), [hidden]);
  return { hidden, toggle, isHidden };
}
