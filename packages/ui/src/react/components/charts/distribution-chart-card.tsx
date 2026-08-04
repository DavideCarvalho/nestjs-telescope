import type { JSX } from 'react';
import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  chartColorVar,
} from '../../ui/chart.js';
import { ChartCard, ChartEmptyState } from './chart-card.js';
import { type ChartSelection, chartSelection } from './chart-selection.js';
import { chartConfig } from './chart-theme.js';

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * The percentile chips. `tint-*` rather than three inline colour strings: the
 * tint classes are the console's single source of truth for a tinted chip, and
 * they carry a `--good`/`--warn`/`--bad` that flips with the theme — the old
 * `${color}22` concatenation only worked because the colours were hard-coded
 * hexes, and would have produced an invalid colour the moment one became a token.
 */
const MARKER_TINT = {
  p50: 'tint-good',
  p95: 'tint-warn',
  p99: 'tint-bad',
} as const;

/** Latency histogram with p50/p95/p99 chips above it. */
export function DistributionChartCard({
  title,
  buckets,
  p50,
  p95,
  p99,
  height = 220,
  onSelect,
}: {
  title: string;
  buckets: { label: string; count: number }[];
  p50?: number;
  p95?: number;
  p99?: number;
  height?: number;
  /** Drill-down: called with the bucket under a click. Omit and the chart is inert. */
  onSelect?: (selection: ChartSelection) => void;
}): JSX.Element {
  const chips: Array<[number, keyof typeof MARKER_TINT]> = [];
  if (p50 !== undefined) chips.push([p50, 'p50']);
  if (p95 !== undefined) chips.push([p95, 'p95']);
  if (p99 !== undefined) chips.push([p99, 'p99']);
  const bodyHeight = height - 64;
  const config = useMemo(() => chartConfig(['count'], () => 'var(--live)'), []);

  const clickProps = onSelect
    ? {
        onClick: (_datum: unknown, index: number) => {
          const bucket = buckets[index];
          if (bucket) onSelect(chartSelection({ label: bucket.label, value: bucket.count }));
        },
        cursor: 'pointer' as const,
      }
    : {};

  return (
    <ChartCard title={title} height={bodyHeight}>
      {/* Column layout so the chips take their height off the chart instead of
          out of the card — the chart used to ask for 100% of a body the chips
          were already sitting in, and overflowed it by exactly their height. */}
      <div className="flex h-full flex-col">
        {chips.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-2">
            {chips.map(([value, name]) => (
              <span
                key={name}
                className={`rounded border px-1.5 text-[10px] tabular-nums ${MARKER_TINT[name]}`}
              >
                {name}: {formatDuration(value)}
              </span>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1">
          {buckets.length === 0 ? (
            <ChartEmptyState />
          ) : (
            <ChartContainer config={config}>
              <BarChart data={buckets} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} />
                <YAxis tickLine={false} allowDecimals={false} width={40} />
                <ChartTooltip
                  cursor={{ fill: 'color-mix(in srgb, var(--text) 5%, transparent)' }}
                  content={<ChartTooltipContent />}
                />
                <Bar
                  dataKey="count"
                  name="count"
                  fill={chartColorVar('count')}
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={false}
                  {...clickProps}
                />
              </BarChart>
            </ChartContainer>
          )}
        </div>
      </div>
    </ChartCard>
  );
}
