import type { JSX } from 'react';
import { RadialBar, RadialBarChart, ResponsiveContainer } from 'recharts';
import { ChartCard } from './chart-card.js';

export function GaugeCard({
  title,
  value,
  min = 0,
  max = 1,
  label,
  color = '#34d399',
  height = 220,
}: {
  title: string;
  value: number;
  min?: number;
  max?: number;
  label?: string;
  color?: string;
  height?: number;
}): JSX.Element {
  const range = max - min;
  const pct = range === 0 ? 0 : Math.max(0, Math.min(1, (value - min) / range));
  const displayLabel = label ?? `${Math.round(pct * 100)}%`;
  const bodyHeight = height - 64;

  const data = [{ value: pct * 100, fill: color }];

  return (
    <ChartCard title={title} height={bodyHeight}>
      <div style={{ position: 'relative', height: bodyHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            innerRadius="60%"
            outerRadius="100%"
            data={data}
            startAngle={180}
            endAngle={0}
            barSize={16}
          >
            <RadialBar dataKey="value" cornerRadius={4} isAnimationActive={false} />
          </RadialBarChart>
        </ResponsiveContainer>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            paddingTop: '40%',
          }}
        >
          <span style={{ fontSize: 20, fontWeight: 600, color: '#e4e4e7' }}>{displayLabel}</span>
        </div>
      </div>
    </ChartCard>
  );
}
