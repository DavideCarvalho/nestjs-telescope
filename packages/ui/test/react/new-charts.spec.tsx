// packages/ui/test/react/new-charts.spec.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BreakdownCard } from '../../src/react/components/charts/breakdown-card.js';
import { DistributionChartCard } from '../../src/react/components/charts/distribution-chart-card.js';
import { GaugeCard } from '../../src/react/components/charts/gauge-card.js';

describe('new chart cards', () => {
  it('render without throwing', () => {
    expect(() =>
      render(
        <DistributionChartCard
          title="Dur"
          buckets={[
            { label: '0-1s', count: 5 },
            { label: '1-2s', count: 3 },
          ]}
          p95={1500}
        />,
      ),
    ).not.toThrow();
    expect(() => render(<GaugeCard title="Success" value={0.987} max={1} />)).not.toThrow();
    expect(() =>
      render(
        <BreakdownCard
          title="States"
          segments={[
            { label: 'done', value: 90 },
            { label: 'failed', value: 10 },
          ]}
        />,
      ),
    ).not.toThrow();
  });

  it('renders percentile chip values in the DOM', () => {
    render(
      <DistributionChartCard
        title="D"
        buckets={[{ label: '0.0s', count: 1 }]}
        p50={500}
        p95={1400}
        p99={2000}
      />,
    );
    expect(screen.getByText(/500ms/)).toBeTruthy();
    expect(screen.getByText(/1\.4s/)).toBeTruthy();
    expect(screen.getByText(/2\.0s/)).toBeTruthy();
  });
});
