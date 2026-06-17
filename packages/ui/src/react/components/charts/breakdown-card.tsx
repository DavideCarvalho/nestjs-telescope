import type { JSX } from 'react';
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { ChartCard } from './chart-card.js';
import { tooltipContentStyle, tooltipItemStyle, tooltipLabelStyle } from './chart-theme.js';

const DEFAULT_PALETTE = ['#34d399', '#fbbf24', '#f87171', '#38bdf8', '#a78bfa'];

function resolveColor(index: number, override?: string): string {
  if (override) return override;
  return DEFAULT_PALETTE[index % DEFAULT_PALETTE.length] ?? '#71717a';
}

export function BreakdownCard({
  title,
  segments,
  style = 'donut',
  height = 220,
}: {
  title: string;
  segments: { label: string; value: number; color?: string }[];
  style?: 'donut' | 'bar';
  height?: number;
}): JSX.Element {
  const bodyHeight = height - 64;

  if (style === 'bar') {
    const data = [
      { name: 'breakdown', ...Object.fromEntries(segments.map((s) => [s.label, s.value])) },
    ];
    return (
      <ChartCard title={title} height={bodyHeight}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical">
            <Tooltip
              contentStyle={tooltipContentStyle}
              labelStyle={tooltipLabelStyle}
              itemStyle={tooltipItemStyle}
            />
            {segments.map((seg, i) => (
              <Bar
                key={seg.label}
                dataKey={seg.label}
                stackId="a"
                fill={resolveColor(i, seg.color)}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    );
  }

  const pieData = segments.map((seg, i) => ({
    name: seg.label,
    value: seg.value,
    fill: resolveColor(i, seg.color),
  }));

  return (
    <ChartCard title={title} height={bodyHeight}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="name"
            innerRadius="55%"
            outerRadius="80%"
            isAnimationActive={false}
          >
            {pieData.map((entry) => (
              <Cell key={entry.name} fill={entry.fill} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={tooltipContentStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={tooltipItemStyle}
          />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
