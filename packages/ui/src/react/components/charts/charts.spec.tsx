import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AreaChartCard } from './area-chart-card.js';
import { BarChartCard } from './bar-chart-card.js';
import { StackedAreaChartCard } from './stacked-area-chart-card.js';

// jsdom: ResponsiveContainer measures 0x0 so the chart body renders empty.
// These specs assert the React wiring (card title + empty-state fallback),
// not the SVG pixels — see the plan's jsdom note.

describe('AreaChartCard', () => {
  it('renders its title with data', () => {
    render(
      <AreaChartCard
        title="Throughput"
        data={[
          { label: '12:00', value: 4 },
          { label: '12:01', value: 7 },
        ]}
      />,
    );
    expect(screen.getByText('Throughput')).toBeTruthy();
  });

  it('shows an empty state with no data', () => {
    render(<AreaChartCard title="Throughput" data={[]} />);
    expect(screen.getByText('No data in window.')).toBeTruthy();
  });
});

describe('StackedAreaChartCard', () => {
  it('renders its title with multi-series data', () => {
    render(
      <StackedAreaChartCard
        title="By type"
        series={['request', 'query']}
        data={[{ label: '12:00', request: 2, query: 5 }]}
      />,
    );
    expect(screen.getByText('By type')).toBeTruthy();
  });

  it('shows an empty state when there are no series', () => {
    render(<StackedAreaChartCard title="By type" series={[]} data={[]} />);
    expect(screen.getByText('No data in window.')).toBeTruthy();
  });
});

describe('BarChartCard', () => {
  it('renders its title with categorical data', () => {
    render(
      <BarChartCard
        title="Failure rate"
        valueLabel="fail %"
        data={[
          { label: 'mail', value: 1.2 },
          { label: 'sms', value: 0 },
        ]}
      />,
    );
    expect(screen.getByText('Failure rate')).toBeTruthy();
  });

  it('shows an empty state with no data', () => {
    render(<BarChartCard title="Failure rate" data={[]} />);
    expect(screen.getByText('No data in window.')).toBeTruthy();
  });
});
