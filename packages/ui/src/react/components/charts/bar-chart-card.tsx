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
  /** Category label on the x-axis (or y-axis when horizontal). */
  label: string;
  /** Bar value. */
  value: number;
  /** Optional per-bar color override. */
  color?: string;
  /** Optional stable identifier carried through to {@link onBarClick}. */
  id?: string;
}

/** Truncate a long category label to `max` chars with a trailing ellipsis. */
function truncate(label: string, max: number): string {
  if (label.length <= max) return label;
  return `${label.slice(0, Math.max(0, max - 1))}…`;
}

/** Categorical bar chart (e.g. per-queue failure rate) with a hover tooltip. */
export function BarChartCard({
  title,
  data,
  right,
  color = ACCENT_HEX,
  valueLabel = 'value',
  height = 220,
  horizontal = false,
  truncateLabel,
  onBarClick,
}: {
  title: string;
  data: BarChartDatum[];
  right?: React.ReactNode;
  color?: string;
  valueLabel?: string;
  height?: number;
  /** Render category labels down the Y axis so long labels read left-to-right. */
  horizontal?: boolean;
  /** Truncate tick labels to this many chars (full label stays in the tooltip). */
  truncateLabel?: number;
  /** Called with the datum behind a clicked bar. */
  onBarClick?: (datum: BarChartDatum) => void;
}): JSX.Element {
  const bodyHeight = height - 64;

  function handleBarClick(_value: unknown, index: number): void {
    const datum = data[index];
    if (datum && onBarClick) onBarClick(datum);
  }

  // Build optional props conditionally: under `exactOptionalPropertyTypes` an
  // explicit `undefined` is not assignable to Recharts' optional handlers.
  const tickFormatterProps =
    truncateLabel !== undefined
      ? { tickFormatter: (value: string) => truncate(value, truncateLabel) }
      : {};
  const barInteractionProps =
    onBarClick !== undefined ? { onClick: handleBarClick, cursor: 'pointer' } : {};

  return (
    <ChartCard title={title} right={right} height={bodyHeight}>
      {data.length === 0 ? (
        <ChartEmptyState height={bodyHeight} />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          {horizontal ? (
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
            >
              <CartesianGrid stroke={chartTheme.gridStroke} horizontal={false} />
              <XAxis
                type="number"
                tick={axisTickStyle}
                stroke={chartTheme.axisStroke}
                tickLine={false}
                allowDecimals={false}
              />
              <YAxis
                type="category"
                dataKey="label"
                tick={axisTickStyle}
                {...tickFormatterProps}
                stroke={chartTheme.axisStroke}
                tickLine={false}
                width={160}
                interval={0}
              />
              <Tooltip
                contentStyle={tooltipContentStyle}
                labelStyle={tooltipLabelStyle}
                itemStyle={tooltipItemStyle}
                cursor={{ fill: '#ffffff08' }}
              />
              <Bar
                dataKey="value"
                name={valueLabel}
                radius={[0, 3, 3, 0]}
                isAnimationActive={false}
                {...barInteractionProps}
              >
                {data.map((datum) => (
                  <Cell key={datum.id ?? datum.label} fill={datum.color ?? color} />
                ))}
              </Bar>
            </BarChart>
          ) : (
            <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke={chartTheme.gridStroke} vertical={false} />
              <XAxis
                dataKey="label"
                tick={axisTickStyle}
                {...tickFormatterProps}
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
              <Bar
                dataKey="value"
                name={valueLabel}
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
                {...barInteractionProps}
              >
                {data.map((datum) => (
                  <Cell key={datum.id ?? datum.label} fill={datum.color ?? color} />
                ))}
              </Bar>
            </BarChart>
          )}
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
