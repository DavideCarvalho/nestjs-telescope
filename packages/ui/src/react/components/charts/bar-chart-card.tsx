import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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

export interface BarChartDatum {
  /** Category label on the x-axis. */
  label: string;
  /** Bar value. */
  value: number;
  /** Optional per-bar color override. */
  color?: string;
}

/** Categorical bar chart (e.g. per-queue failure rate) with a hover tooltip. */
export function BarChartCard({
  title,
  data,
  right,
  color = ACCENT_HEX,
  valueLabel = 'value',
  height = 220,
}: {
  title: string;
  data: BarChartDatum[];
  right?: React.ReactNode;
  color?: string;
  valueLabel?: string;
  height?: number;
}): JSX.Element {
  const bodyHeight = height - 64;
  return (
    <ChartCard title={title} right={right} height={bodyHeight}>
      {data.length === 0 ? (
        <ChartEmptyState height={bodyHeight} />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid stroke={chartTheme.gridStroke} vertical={false} />
            <XAxis
              dataKey="label"
              tick={axisTickStyle}
              stroke={chartTheme.axisStroke}
              tickLine={false}
              interval={0}
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
              cursor={{ fill: '#ffffff08' }}
            />
            <Bar dataKey="value" name={valueLabel} radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {data.map((datum) => (
                <Cell key={datum.label} fill={datum.color ?? color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
