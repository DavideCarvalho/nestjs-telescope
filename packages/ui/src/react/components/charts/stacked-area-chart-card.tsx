import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartCard, ChartEmptyState } from './chart-card.js';
import {
  axisTickStyle,
  chartTheme,
  hexForType,
  tooltipContentStyle,
  tooltipItemStyle,
  tooltipLabelStyle,
} from './chart-theme.js';

/** Each row carries the x-axis `label` plus one numeric key per series. */
export type StackedAreaRow = { label: string } & Record<string, string | number>;

/** Multi-series stacked area chart with a legend, colored per entry type. */
export function StackedAreaChartCard({
  title,
  data,
  series,
  right,
  height = 240,
}: {
  title: string;
  data: StackedAreaRow[];
  /** Ordered list of series keys (e.g. entry types) to stack. */
  series: string[];
  right?: React.ReactNode;
  height?: number;
}): JSX.Element {
  const bodyHeight = height - 64;
  return (
    <ChartCard title={title} right={right} height={bodyHeight}>
      {data.length === 0 || series.length === 0 ? (
        <ChartEmptyState height={bodyHeight} />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
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
            <Legend
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 10, color: chartTheme.legendText }}
            />
            {series.map((key, index) => {
              const color = hexForType(key, index);
              return (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={key}
                  name={key}
                  stackId="1"
                  stroke={color}
                  strokeWidth={1.5}
                  fill={color}
                  fillOpacity={0.25}
                  isAnimationActive={false}
                />
              );
            })}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
