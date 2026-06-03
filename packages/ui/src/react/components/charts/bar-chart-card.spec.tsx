import { fireEvent, render, screen } from '@testing-library/react';
import { cloneElement, isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BarChartDatum } from './bar-chart-card.js';

// jsdom measures Recharts' ResponsiveContainer at 0x0, so its child chart never
// renders any bars. Mock the container to hand its single child a fixed size,
// which lets real <Bar> rectangles render and be clicked.
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

import { BarChartCard } from './bar-chart-card.js';

const data: BarChartDatum[] = [
  { label: 'select * from a', value: 10, id: 'h1' },
  { label: 'select * from b where really_long_column = something', value: 42, id: 'h2' },
];

function bars(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll('.recharts-bar-rectangle');
}

describe('BarChartCard interactions', () => {
  it('renders the horizontal + truncated variant without error', () => {
    const { container } = render(
      <BarChartCard title="Slowest query shapes (p99)" data={data} horizontal truncateLabel={24} />,
    );
    expect(screen.getByText('Slowest query shapes (p99)')).toBeTruthy();
    expect(bars(container).length).toBe(2);
  });

  it('fires onBarClick with the datum behind the clicked bar', () => {
    const onBarClick = vi.fn<(datum: BarChartDatum) => void>();
    const { container } = render(
      <BarChartCard title="Shapes" data={data} horizontal onBarClick={onBarClick} />,
    );

    const clicked = bars(container)[1];
    expect(clicked).toBeTruthy();
    if (clicked) fireEvent.click(clicked);

    expect(onBarClick).toHaveBeenCalledTimes(1);
    expect(onBarClick).toHaveBeenCalledWith(data[1]);
  });

  it('does not throw when clicking a bar with no onBarClick wired', () => {
    const { container } = render(<BarChartCard title="Shapes" data={data} />);
    const clicked = bars(container)[0];
    expect(clicked).toBeTruthy();
    if (clicked) fireEvent.click(clicked);
    expect(screen.getByText('Shapes')).toBeTruthy();
  });
});
