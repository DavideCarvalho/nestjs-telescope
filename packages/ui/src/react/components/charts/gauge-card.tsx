import type { JSX } from 'react';
import { useMemo } from 'react';
import { PolarAngleAxis, RadialBar, RadialBarChart } from 'recharts';
import { ChartContainer, chartColorVar } from '../../ui/chart.js';
import { ChartCard } from './chart-card.js';
import { chartConfig } from './chart-theme.js';

/** Half-dial gauge: one value against a min/max, with the reading over the arc. */
export function GaugeCard({
  title,
  value,
  min = 0,
  max = 1,
  label,
  color = 'var(--good)',
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
  const config = useMemo(
    () =>
      chartConfig(
        ['value'],
        () => color,
        () => title,
      ),
    [color, title],
  );

  const data = [{ value: pct * 100 }];

  return (
    <ChartCard title={title} height={bodyHeight}>
      <div className="relative h-full">
        <ChartContainer config={config}>
          <RadialBarChart
            innerRadius="60%"
            outerRadius="100%"
            data={data}
            startAngle={180}
            endAngle={0}
            barSize={16}
          >
            {/* The dial's scale, stated explicitly. Without it Recharts derives the
                angular domain from the data itself — and with a single datum that
                domain is `[0, value]`, so every gauge drew a full half-circle no
                matter what it was reporting. */}
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
            <RadialBar
              dataKey="value"
              fill={chartColorVar('value')}
              background
              cornerRadius={4}
              isAnimationActive={false}
            />
          </RadialBarChart>
        </ChartContainer>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center pt-[40%]">
          <span className="text-xl font-semibold tabular-nums text-foreground">{displayLabel}</span>
        </div>
      </div>
    </ChartCard>
  );
}
