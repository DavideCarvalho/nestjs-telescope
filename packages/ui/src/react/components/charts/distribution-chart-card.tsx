import type { JSX } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartCard } from './chart-card.js';
import {
  axisTickStyle,
  chartTheme,
  tooltipContentStyle,
  tooltipItemStyle,
  tooltipLabelStyle,
} from './chart-theme.js';

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function DistributionChartCard({
  title,
  buckets,
  p50,
  p95,
  p99,
  height = 220,
}: {
  title: string;
  buckets: { label: string; count: number }[];
  p50?: number;
  p95?: number;
  p99?: number;
  height?: number;
}): JSX.Element {
  const chips: Array<[number, string, string]> = [];
  if (p50 !== undefined) chips.push([p50, 'p50', '#34d399']);
  if (p95 !== undefined) chips.push([p95, 'p95', '#fbbf24']);
  if (p99 !== undefined) chips.push([p99, 'p99', '#f87171']);
  const bodyHeight = height - 64;
  return (
    <ChartCard title={title} height={bodyHeight}>
      {chips.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          {chips.map(([val, name, color]) => (
            <span
              key={name}
              style={{
                fontSize: 10,
                fontVariantNumeric: 'tabular-nums',
                color,
                background: `${color}22`,
                border: `1px solid ${color}55`,
                borderRadius: 4,
                padding: '1px 6px',
              }}
            >
              {name}: {formatDuration(val)}
            </span>
          ))}
        </div>
      )}
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={buckets} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke={chartTheme.gridStroke} vertical={false} />
          <XAxis
            dataKey="label"
            tick={axisTickStyle}
            stroke={chartTheme.axisStroke}
            tickLine={false}
          />
          <YAxis
            tick={axisTickStyle}
            stroke={chartTheme.axisStroke}
            tickLine={false}
            allowDecimals={false}
            width={40}
          />
          <Tooltip
            contentStyle={tooltipContentStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={tooltipItemStyle}
          />
          <Bar dataKey="count" fill="#0ea5e9" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
