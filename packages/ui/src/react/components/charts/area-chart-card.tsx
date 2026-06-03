import { useId } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartCard, ChartEmptyState } from './chart-card.js';
import {
  ACCENT_HEX,
  axisTickStyle,
  chartTheme,
  tooltipContentStyle,
  tooltipItemStyle,
  tooltipLabelStyle,
} from './chart-theme.js';

export interface AreaChartPoint {
  /** X-axis label (e.g. formatted time). */
  label: string;
  /** Series value. */
  value: number;
}

/** Single-series time area chart with a subtle gradient fill and hover tooltip. */
export function AreaChartCard({
  title,
  data,
  right,
  color = ACCENT_HEX,
  valueLabel = 'value',
  height = 220,
}: {
  title: string;
  data: AreaChartPoint[];
  right?: React.ReactNode;
  color?: string;
  valueLabel?: string;
  height?: number;
}): JSX.Element {
  const gradientId = useId();
  const bodyHeight = height - 64;
  return (
    <ChartCard title={title} right={right} height={bodyHeight}>
      {data.length === 0 ? (
        <ChartEmptyState height={bodyHeight} />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={chartTheme.gridStroke} vertical={false} />
            <XAxis
              dataKey="label"
              tick={axisTickStyle}
              stroke={chartTheme.axisStroke}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tick={axisTickStyle}
              stroke={chartTheme.axisStroke}
              tickLine={false}
              width={40}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={tooltipContentStyle}
              labelStyle={tooltipLabelStyle}
              itemStyle={tooltipItemStyle}
              cursor={{ stroke: chartTheme.axisStroke }}
            />
            <Area
              type="monotone"
              dataKey="value"
              name={valueLabel}
              stroke={color}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 3 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
