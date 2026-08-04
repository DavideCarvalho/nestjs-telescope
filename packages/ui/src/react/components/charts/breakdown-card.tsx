import type { JSX } from 'react';
import { useMemo } from 'react';
import { Bar, BarChart, Cell, Pie, PieChart } from 'recharts';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '../../ui/chart.js';
import { ChartCard, ChartEmptyState } from './chart-card.js';
import { type ChartSelection, chartSelection } from './chart-selection.js';
import { chartConfig, hexForSegment } from './chart-theme.js';

export interface BreakdownSegment {
  label: string;
  value: number;
  color?: string;
}

/** Donut (default) or single stacked bar showing how a total splits by category. */
export function BreakdownCard({
  title,
  segments,
  style = 'donut',
  height = 220,
  onSelect,
}: {
  title: string;
  segments: BreakdownSegment[];
  style?: 'donut' | 'bar';
  height?: number;
  /** Drill-down: called with the segment under a click. Omit and the chart is inert. */
  onSelect?: (selection: ChartSelection) => void;
}): JSX.Element {
  const bodyHeight = height - 64;
  const config = useMemo(
    () =>
      chartConfig(
        segments.map((s) => s.label),
        (label, index) => hexForSegment(label, index, segments[index]?.color),
      ),
    [segments],
  );

  function select(index: number): void {
    const segment = segments[index];
    if (segment && onSelect) {
      onSelect(chartSelection({ label: segment.label, value: segment.value }));
    }
  }

  // Recharts hands a click handler its own datum first; the index is what we
  // actually key off, so the datum is deliberately ignored.
  const clickProps = onSelect
    ? { onClick: (_datum: unknown, index: number) => select(index), cursor: 'pointer' as const }
    : {};

  if (segments.length === 0) {
    return (
      <ChartCard title={title} height={bodyHeight}>
        <ChartEmptyState height={bodyHeight} />
      </ChartCard>
    );
  }

  if (style === 'bar') {
    // One row, one stacked bar per segment: the chart is a single 100% bar, so
    // every segment is its own series rather than a row in a shared one.
    const row = [
      { name: 'breakdown', ...Object.fromEntries(segments.map((s) => [s.label, s.value])) },
    ];
    return (
      <ChartCard title={title} height={bodyHeight}>
        <ChartContainer config={config}>
          <BarChart data={row} layout="vertical">
            <ChartTooltip content={<ChartTooltipContent hideLabel />} />
            <ChartLegend content={<ChartLegendContent />} />
            {segments.map((segment, index) => (
              <Bar
                key={segment.label}
                dataKey={segment.label}
                stackId="a"
                fill={hexForSegment(segment.label, index, segment.color)}
                isAnimationActive={false}
                {...(onSelect ? { onClick: () => select(index), cursor: 'pointer' as const } : {})}
              />
            ))}
          </BarChart>
        </ChartContainer>
      </ChartCard>
    );
  }

  const pieData = segments.map((segment, index) => ({
    name: segment.label,
    value: segment.value,
    // `color` (not `fill`) so the hover card and the legend resolve the segment's
    // own hue — see `seriesColor` in the vendored chart layer.
    color: hexForSegment(segment.label, index, segment.color),
  }));

  return (
    <ChartCard title={title} height={bodyHeight}>
      <ChartContainer config={config}>
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent hideLabel />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="name"
            innerRadius="55%"
            outerRadius="80%"
            isAnimationActive={false}
            {...clickProps}
          >
            {pieData.map((entry) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
    </ChartCard>
  );
}
