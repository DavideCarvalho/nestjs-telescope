import { fireEvent, render, screen } from '@testing-library/react';
import { cloneElement, isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { activeChartLabel } from './chart-selection.js';
import type { ChartSelection } from './chart-selection.js';

// jsdom measures Recharts' ResponsiveContainer at 0x0, so its child chart never
// renders any marks. Mock the container to hand its single child a fixed size —
// the same stub `bar-chart-card.spec.tsx` uses — which lets real sectors, bars,
// areas and the brush render and be clicked.
vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  function MockResponsiveContainer({ children }: { children: React.ReactNode }): JSX.Element {
    return (
      <div>
        {isValidElement(children) ? cloneElement(children, { width: 600, height: 300 }) : children}
      </div>
    );
  }
  return { ...actual, ResponsiveContainer: MockResponsiveContainer };
});

import { AreaChartCard } from './area-chart-card.js';
import { BreakdownCard } from './breakdown-card.js';
import { DistributionChartCard } from './distribution-chart-card.js';
import { StackedAreaChartCard } from './stacked-area-chart-card.js';

function series(points: number): { label: string; value: number }[] {
  return Array.from({ length: points }, (_, i) => ({ label: `12:${i}`, value: i }));
}

describe('AreaChartCard brush', () => {
  it('adds a range brush once the window is long', () => {
    const { container } = render(<AreaChartCard title="Throughput" data={series(30)} />);
    expect(container.querySelector('.recharts-brush')).toBeTruthy();
  });

  it('leaves it off for a short window, where it is a scrollbar for a page that fits', () => {
    const { container } = render(<AreaChartCard title="Throughput" data={series(6)} />);
    expect(container.querySelector('.recharts-brush')).toBeNull();
  });

  it('honours an explicit opt-out on a long window', () => {
    const { container } = render(
      <AreaChartCard title="Throughput" data={series(30)} brush={false} />,
    );
    expect(container.querySelector('.recharts-brush')).toBeNull();
  });
});

describe('StackedAreaChartCard legend', () => {
  const data = [
    { label: '12:00', request: 2, query: 5 },
    { label: '12:01', request: 3, query: 4 },
  ];

  it('hides a series when its legend entry is toggled off', () => {
    const { container } = render(
      <StackedAreaChartCard title="By type" series={['request', 'query']} data={data} />,
    );
    expect(container.querySelectorAll('.recharts-area').length).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: /request/ }));

    expect(container.querySelectorAll('.recharts-area').length).toBe(1);
    expect(screen.getByRole('button', { name: /request/ }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('brings it back on a second click', () => {
    const { container } = render(
      <StackedAreaChartCard title="By type" series={['request', 'query']} data={data} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /query/ }));
    fireEvent.click(screen.getByRole('button', { name: /query/ }));
    expect(container.querySelectorAll('.recharts-area').length).toBe(2);
  });
});

describe('BreakdownCard drill-down', () => {
  const segments = [
    { label: 'completed', value: 8 },
    { label: 'failed', value: 2 },
  ];

  it('reports the clicked segment', () => {
    const onSelect = vi.fn<(selection: ChartSelection) => void>();
    const { container } = render(
      <BreakdownCard title="Outcomes" segments={segments} onSelect={onSelect} />,
    );
    const sector = container.querySelectorAll('.recharts-sector')[1];
    expect(sector).toBeTruthy();
    if (sector) fireEvent.click(sector);
    expect(onSelect).toHaveBeenCalledWith({ label: 'failed', value: 2 });
  });

  it('does not throw when clicked with no drill-down wired', () => {
    const { container } = render(<BreakdownCard title="Outcomes" segments={segments} />);
    const sector = container.querySelector('.recharts-sector');
    if (sector) fireEvent.click(sector);
    expect(screen.getByText('Outcomes')).toBeTruthy();
  });

  it('shows an empty state rather than an empty ring', () => {
    render(<BreakdownCard title="Outcomes" segments={[]} />);
    expect(screen.getByText('No data in window.')).toBeTruthy();
  });
});

describe('DistributionChartCard', () => {
  const buckets = [
    { label: '0-10ms', count: 4 },
    { label: '10-50ms', count: 9 },
  ];

  it('reports the clicked bucket', () => {
    const onSelect = vi.fn<(selection: ChartSelection) => void>();
    const { container } = render(
      <DistributionChartCard title="Latency" buckets={buckets} onSelect={onSelect} />,
    );
    const bar = container.querySelectorAll('.recharts-bar-rectangle')[1];
    expect(bar).toBeTruthy();
    if (bar) fireEvent.click(bar);
    expect(onSelect).toHaveBeenCalledWith({ label: '10-50ms', value: 9 });
  });

  it('renders percentile chips as tinted pills', () => {
    render(<DistributionChartCard title="Latency" buckets={buckets} p50={12} p99={2400} />);
    expect(screen.getByText('p50: 12ms')).toBeTruthy();
    expect(screen.getByText('p99: 2.4s')).toBeTruthy();
  });
});

describe('activeChartLabel', () => {
  // The timeseries drill-down reads the hovered category out of Recharts' chart
  // event state, which is only loosely typed on its side — so the narrowing is
  // asserted directly rather than through a jsdom "hover" that has no geometry.
  it('reads the active category off the chart event state', () => {
    expect(activeChartLabel({ activeLabel: '12:00' })).toBe('12:00');
    expect(activeChartLabel({ activeLabel: 3 })).toBe('3');
  });

  it('returns undefined for a click that landed on chrome', () => {
    expect(activeChartLabel({ activeLabel: '' })).toBeUndefined();
    expect(activeChartLabel({})).toBeUndefined();
    expect(activeChartLabel(null)).toBeUndefined();
    expect(activeChartLabel(undefined)).toBeUndefined();
  });
});
