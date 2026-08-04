import type { JSX, ReactNode } from 'react';
import { useMemo } from 'react';
import { Area, AreaChart, Brush, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  chartBrushProps,
  chartColorVar,
  useSeriesToggle,
} from '../../ui/chart.js';
import { ChartCard, ChartEmptyState } from './chart-card.js';
import { type ChartSelection, activeChartLabel, chartSelection } from './chart-selection.js';
import { chartConfig, hexForType } from './chart-theme.js';

/** Each row carries the x-axis `label` plus one numeric key per series. */
export type StackedAreaRow = { label: string } & Record<string, string | number>;

/** Points past which the chart gets a range brush — see `area-chart-card.tsx`. */
const BRUSH_MIN_POINTS = 24;

/**
 * Multi-series stacked area chart, coloured per entry type, with a legend whose
 * entries toggle their series and a brush for narrowing a long window.
 *
 * Hiding a series restacks the rest, which is the point: with six types stacked,
 * the only way to read the two small ones is to switch the big ones off.
 */
export function StackedAreaChartCard({
  title,
  data,
  series,
  right,
  height = 240,
  brush,
  onSelect,
}: {
  title: string;
  data: StackedAreaRow[];
  /** Ordered list of series keys (e.g. entry types) to stack. */
  series: string[];
  right?: ReactNode;
  height?: number;
  /** Force the range brush on or off. Defaults to on once the series is long. */
  brush?: boolean;
  /** Drill-down: called with the bucket under a click. Omit and the chart is inert. */
  onSelect?: (selection: ChartSelection) => void;
}): JSX.Element {
  const bodyHeight = height - 64;
  const config = useMemo(() => chartConfig(series, hexForType), [series]);
  const { hidden, toggle, isHidden } = useSeriesToggle();
  const showBrush = brush ?? data.length >= BRUSH_MIN_POINTS;

  // See `area-chart-card.tsx` for why the handler is spread rather than passed
  // as a possibly-undefined prop.
  const clickProps = onSelect
    ? {
        onClick: (state: unknown) => {
          const label = activeChartLabel(state);
          if (label !== undefined) onSelect(chartSelection({ label }));
        },
        className: 'cursor-pointer',
      }
    : {};

  return (
    <ChartCard title={title} right={right} height={bodyHeight}>
      {data.length === 0 || series.length === 0 ? (
        <ChartEmptyState height={bodyHeight} />
      ) : (
        <ChartContainer config={config}>
          <AreaChart
            data={data}
            margin={{ top: 4, right: 8, bottom: 0, left: -16 }}
            {...clickProps}
          >
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} minTickGap={24} />
            <YAxis tickLine={false} width={40} allowDecimals={false} />
            <ChartTooltip cursor={{ stroke: 'var(--line)' }} content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent hidden={hidden} onToggle={toggle} />} />
            {series.map((key) => (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                name={key}
                stackId="1"
                stroke={chartColorVar(key)}
                strokeWidth={1.5}
                fill={chartColorVar(key)}
                fillOpacity={0.25}
                hide={isHidden(key)}
                isAnimationActive={false}
              />
            ))}
            {showBrush && <Brush {...chartBrushProps} dataKey="label" />}
          </AreaChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}
