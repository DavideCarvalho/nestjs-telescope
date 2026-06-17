import type { JSX } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartCard } from './chart-card.js';
import {
  axisTickStyle,
  chartTheme,
  tooltipContentStyle,
  tooltipItemStyle,
  tooltipLabelStyle,
} from './chart-theme.js';

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
  const marks: Array<[number | undefined, string, string]> = [
    [p50, 'p50', '#34d399'],
    [p95, 'p95', '#fbbf24'],
    [p99, 'p99', '#f87171'],
  ];
  const bodyHeight = height - 64;
  return (
    <ChartCard title={title} height={bodyHeight}>
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
          {marks.map(([val, name, color]) =>
            val !== undefined ? (
              <ReferenceLine
                key={name}
                x={String(val)}
                stroke={color}
                strokeDasharray="3 3"
                label={{ value: name, fontSize: 9, fill: color }}
              />
            ) : null,
          )}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
