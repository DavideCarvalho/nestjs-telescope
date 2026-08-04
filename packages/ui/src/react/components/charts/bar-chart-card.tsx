import type { JSX, ReactNode } from 'react';
import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  chartColorVar,
} from '../../ui/chart.js';
import { ChartCard, ChartEmptyState } from './chart-card.js';
import { type ChartSelection, chartSelection } from './chart-selection.js';
import { ACCENT_HEX, chartConfig } from './chart-theme.js';

export interface BarChartDatum {
  /** Category label on the x-axis (or y-axis when horizontal). */
  label: string;
  /** Bar value. */
  value: number;
  /** Optional per-bar color override. */
  color?: string;
  /** Optional stable identifier carried through to {@link BarChartCardProps.onSelect}. */
  id?: string;
}

/** Truncate a long category label to `max` chars with a trailing ellipsis. */
function truncate(label: string, max: number): string {
  if (label.length <= max) return label;
  return `${label.slice(0, Math.max(0, max - 1))}…`;
}

export interface BarChartCardProps {
  title: string;
  data: BarChartDatum[];
  right?: ReactNode;
  color?: string;
  valueLabel?: string;
  height?: number;
  /** Render category labels down the Y axis so long labels read left-to-right. */
  horizontal?: boolean;
  /** Truncate tick labels to this many chars (full label stays in the hover card). */
  truncateLabel?: number;
  /** Format the value in the hover card (the axis is left alone). */
  valueFormatter?: (value: number) => ReactNode;
  /** Drill-down: called with the bar under a click. Omit and the chart is inert. */
  onSelect?: (selection: ChartSelection) => void;
  /**
   * @deprecated Use {@link BarChartCardProps.onSelect}, which reports the same
   * click in the shape every chart card uses. Still called, so existing callers
   * keep working.
   */
  onBarClick?: (datum: BarChartDatum) => void;
}

/** Categorical bar chart (e.g. per-queue failure rate) with a hover card. */
export function BarChartCard({
  title,
  data,
  right,
  color = ACCENT_HEX,
  valueLabel = 'value',
  height = 220,
  horizontal = false,
  truncateLabel,
  valueFormatter,
  onSelect,
  onBarClick,
}: BarChartCardProps): JSX.Element {
  const bodyHeight = height - 64;
  const config = useMemo(
    () =>
      chartConfig(
        ['value'],
        () => color,
        () => valueLabel,
      ),
    [color, valueLabel],
  );

  function handleBarClick(_value: unknown, index: number): void {
    const datum = data[index];
    if (!datum) return;
    onBarClick?.(datum);
    onSelect?.(chartSelection({ label: datum.label, id: datum.id, value: datum.value }));
  }

  // Optional props are built conditionally: under `exactOptionalPropertyTypes` an
  // explicit `undefined` is not assignable to Recharts' optional handlers.
  const tickFormatterProps =
    truncateLabel !== undefined
      ? { tickFormatter: (value: string) => truncate(value, truncateLabel) }
      : {};
  const interactive = onSelect !== undefined || onBarClick !== undefined;
  const barInteractionProps = interactive
    ? { onClick: handleBarClick, cursor: 'pointer' as const }
    : {};

  return (
    <ChartCard title={title} right={right} height={bodyHeight}>
      {data.length === 0 ? (
        <ChartEmptyState height={bodyHeight} />
      ) : (
        <ChartContainer config={config}>
          {/* One chart, two layouts. The axes swap roles between them, which is the
              whole difference — writing it twice is how the two drifted apart before. */}
          <BarChart
            data={data}
            layout={horizontal ? 'vertical' : 'horizontal'}
            margin={{ top: 4, right: 8, bottom: 0, left: horizontal ? 8 : -16 }}
          >
            <CartesianGrid horizontal={!horizontal} vertical={horizontal} />
            {horizontal ? (
              <XAxis type="number" tickLine={false} allowDecimals={false} />
            ) : (
              <XAxis dataKey="label" tickLine={false} interval={0} {...tickFormatterProps} />
            )}
            {horizontal ? (
              <YAxis
                type="category"
                dataKey="label"
                tickLine={false}
                width={160}
                interval={0}
                {...tickFormatterProps}
              />
            ) : (
              <YAxis tickLine={false} width={40} allowDecimals={false} />
            )}
            <ChartTooltip
              cursor={{ fill: 'color-mix(in srgb, var(--text) 5%, transparent)' }}
              content={
                <ChartTooltipContent
                  {...(valueFormatter ? { valueFormatter: (v: number) => valueFormatter(v) } : {})}
                />
              }
            />
            <Bar
              dataKey="value"
              name={valueLabel}
              fill={chartColorVar('value')}
              radius={horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]}
              isAnimationActive={false}
              {...barInteractionProps}
            >
              {data.map((datum) => (
                <Cell key={datum.id ?? datum.label} fill={datum.color ?? chartColorVar('value')} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}
