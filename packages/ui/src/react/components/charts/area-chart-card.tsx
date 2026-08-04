import type { JSX, ReactNode } from 'react';
import { useId, useMemo } from 'react';
import { Area, AreaChart, Brush, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  chartBrushProps,
  chartColorVar,
} from '../../ui/chart.js';
import { ChartCard, ChartEmptyState } from './chart-card.js';
import { type ChartSelection, activeChartLabel, chartSelection } from './chart-selection.js';
import { ACCENT_HEX, chartConfig } from './chart-theme.js';

export interface AreaChartPoint {
  /** X-axis label (e.g. formatted time). */
  label: string;
  /** Series value. */
  value: number;
}

/**
 * Number of points past which the chart gets a range brush.
 *
 * A brush costs ~20px of an already short body and only earns it when the window
 * is long enough that the interesting part is a slice of it; over a dozen buckets
 * it is a scrollbar for a page that already fits.
 */
const BRUSH_MIN_POINTS = 24;

/** Single-series time area chart with a gradient fill, a hover card and an optional brush. */
export function AreaChartCard({
  title,
  data,
  right,
  color = ACCENT_HEX,
  valueLabel = 'value',
  height = 220,
  brush,
  valueFormatter,
  onSelect,
}: {
  title: string;
  data: AreaChartPoint[];
  right?: ReactNode;
  color?: string;
  valueLabel?: string;
  height?: number;
  /** Force the range brush on or off. Defaults to on once the series is long. */
  brush?: boolean;
  /** Format the value in the hover card (the axis is left alone). */
  valueFormatter?: (value: number) => ReactNode;
  /** Drill-down: called with the point under a click. Omit and the chart is inert. */
  onSelect?: (selection: ChartSelection) => void;
}): JSX.Element {
  const gradientId = useId();
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
  const showBrush = brush ?? data.length >= BRUSH_MIN_POINTS;

  // Interaction props are built conditionally: under `exactOptionalPropertyTypes`
  // an explicit `undefined` is not assignable to Recharts' optional handlers, and
  // a chart with no drill-down target must not advertise a pointer cursor.
  const clickProps = onSelect
    ? {
        onClick: (state: unknown) => {
          const label = activeChartLabel(state);
          if (label === undefined) return;
          const point = data.find((p) => p.label === label);
          onSelect(chartSelection({ label, series: 'value', value: point?.value }));
        },
        className: 'cursor-pointer',
      }
    : {};

  return (
    <ChartCard title={title} right={right} height={bodyHeight}>
      {data.length === 0 ? (
        <ChartEmptyState height={bodyHeight} />
      ) : (
        <ChartContainer config={config}>
          <AreaChart
            data={data}
            margin={{ top: 4, right: 8, bottom: 0, left: -16 }}
            {...clickProps}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chartColorVar('value')} stopOpacity={0.35} />
                <stop offset="100%" stopColor={chartColorVar('value')} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} minTickGap={24} />
            <YAxis tickLine={false} width={40} allowDecimals={false} />
            <ChartTooltip
              cursor={{ stroke: 'var(--line)' }}
              content={
                <ChartTooltipContent
                  {...(valueFormatter ? { valueFormatter: (v: number) => valueFormatter(v) } : {})}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="value"
              name={valueLabel}
              stroke={chartColorVar('value')}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 3 }}
            />
            {showBrush && <Brush {...chartBrushProps} dataKey="label" />}
          </AreaChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}
