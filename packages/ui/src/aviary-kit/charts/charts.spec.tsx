// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BarChart } from './bar-chart';
import { chartTooltip, isEmptyChart, toChartRows, valueTicks } from './chart-kit';
import { DonutChart } from './donut-chart';
import { Sparkline } from './sparkline';
import { TimeSeriesChart } from './time-series-chart';

interface Day {
  day: string;
  costUsd: number;
  runs: number;
  failed: number;
}

const days: Day[] = [
  { day: '2026-11-12', costUsd: 1.5, runs: 10, failed: 1 },
  { day: '2026-11-13', costUsd: 0.25, runs: 4, failed: 0 },
  { day: '2026-11-14', costUsd: 3, runs: 12, failed: 3 },
];
const day = (d: Day) => d.day;
const usd = (n: number) => `$${n.toFixed(2)}`;
const cost = [{ key: 'cost', label: 'cost', value: (d: Day) => d.costUsd }];
const runs = [
  { key: 'runs', label: 'runs', value: (d: Day) => d.runs },
  { key: 'failed', label: 'failed', value: (d: Day) => d.failed, color: 'var(--aviary-bad)' },
];

/** Focus the chart surface (keyboard path) and return the tooltip it opens. */
async function focusChart(name: string) {
  const surface = screen.getByRole('img', { name });
  await act(async () => {
    surface.focus();
    fireEvent.focus(surface);
    await new Promise((r) => setTimeout(r, 20));
  });
  return surface;
}

const tooltipText = () => document.querySelector('.aviary-chart-tooltip')?.textContent ?? '';

afterEach(cleanup);

describe('chart rows', () => {
  it('flattens rows × series, skipping missing values, with stable ids and token colours', () => {
    const rows = toChartRows([{ d: 'a', v: 1, w: null as number | null }], (r) => r.d, [
      { key: 'v', label: 'V', value: (r) => r.v },
      { key: 'w', label: 'W', value: (r) => r.w },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'a\u0000v',
      x: 'a',
      series: 'V',
      value: 1,
      color: 'var(--aviary-accent)',
    });
  });

  it('treats no rows as empty, and all-zero values only when asked', () => {
    const zeros = toChartRows(days, day, [{ key: 'z', label: 'z', value: () => 0 }]);
    expect(isEmptyChart([])).toBe(true);
    expect(isEmptyChart(zeros)).toBe(false);
    expect(isEmptyChart(zeros, true)).toBe(true);
    expect(isEmptyChart(toChartRows(days, day, cost), true)).toBe(false);
  });

  it('keeps count axes on whole numbers', () => {
    const small = toChartRows(days, day, [{ key: 'n', label: 'n', value: (d: Day) => d.failed }]);
    expect(valueTicks(small, true, undefined).count).toBe(3);
    expect(valueTicks(small, false, undefined).count).toBe(4);
  });

  it('builds tooltip content: formatted title, one swatched row per series, extra rows', () => {
    const rows = toChartRows(days, day, runs).filter((r) => r.x === '2026-11-14');
    const options = chartTooltip<Day>({
      formatValue: (n) => `${n} runs`,
      formatX: (x) => `day ${x}`,
      extraRows: (d) => [{ label: 'rate', value: `${Math.round((d.failed / d.runs) * 100)}%` }],
    });
    const points = rows.map((datum) => ({ datum }) as never);
    const content = options.content(points, { primaryPoint: points[1] });
    expect(content.title).toBe('day 2026-11-14');
    expect(content.rows).toEqual([
      { label: 'runs', value: '12 runs', color: 'var(--aviary-accent)', active: false },
      { label: 'failed', value: '3 runs', color: 'var(--aviary-bad)', active: true },
      { label: 'rate', value: '25%' },
    ]);
  });
});

describe('TimeSeriesChart', () => {
  it('renders a named, focusable chart surface', () => {
    render(<TimeSeriesChart data={days} x={day} series={cost} ariaLabel="daily cost" />);
    const surface = screen.getByRole('img', { name: 'daily cost' });
    expect(surface.getAttribute('tabindex')).toBe('0');
    expect(surface.closest('.aviary-chart')).not.toBeNull();
  });

  it('shows the formatted value in the tooltip on keyboard focus', async () => {
    render(
      <TimeSeriesChart
        data={days}
        x={day}
        series={cost}
        formatValue={usd}
        ariaLabel="daily cost"
      />,
    );
    await focusChart('daily cost');
    expect(tooltipText()).toContain('2026-11-12');
    expect(tooltipText()).toContain('$1.50');
  });

  it('renders the empty state instead of a flat chart', () => {
    render(
      <TimeSeriesChart
        data={[]}
        x={day}
        series={cost}
        ariaLabel="daily cost"
        empty="Nothing yet."
      />,
    );
    expect(screen.queryByRole('img', { name: 'daily cost' })).toBeNull();
    expect(screen.getByText('Nothing yet.')).toBeTruthy();
  });
});

describe('BarChart', () => {
  it('shows every series at the focused x', async () => {
    render(
      <BarChart data={days} x={day} series={runs} layout="grouped" ariaLabel="runs per day" />,
    );
    await focusChart('runs per day');
    expect(tooltipText()).toContain('runs');
    expect(tooltipText()).toContain('10');
    expect(tooltipText()).toContain('failed');
  });

  it('draws an all-zero window by default and shows the empty state with emptyWhenZero', () => {
    const zero = days.map((d) => ({ ...d, runs: 0, failed: 0 }));
    const { unmount } = render(
      <BarChart data={zero} x={day} series={runs} ariaLabel="runs per day" />,
    );
    expect(screen.getByRole('img', { name: 'runs per day' })).toBeTruthy();
    unmount();
    render(<BarChart data={zero} x={day} series={runs} ariaLabel="runs per day" emptyWhenZero />);
    expect(screen.getByText('No data in this window.')).toBeTruthy();
  });
});

describe('Sparkline', () => {
  it('shows the point value in the tooltip on keyboard focus', async () => {
    render(
      <Sparkline
        data={days}
        x={day}
        value={(d) => d.runs}
        label="requests"
        ariaLabel="throughput"
        extraRows={(d) => [{ label: 'failed', value: String(d.failed) }]}
      />,
    );
    await focusChart('throughput');
    expect(tooltipText()).toContain('requests');
    expect(tooltipText()).toContain('10');
    expect(tooltipText()).toContain('failed');
  });

  it('draws a flat baseline for an empty series', () => {
    render(
      <Sparkline
        data={[]}
        x={day}
        value={(d: Day) => d.runs}
        label="requests"
        ariaLabel="throughput"
      />,
    );
    expect(screen.getByRole('img', { name: 'throughput' })).toBeTruthy();
  });
});

describe('DonutChart', () => {
  const outcomes = [
    { key: 'completed', n: 30, color: 'var(--aviary-good)' },
    { key: 'failed', n: 10, color: 'var(--aviary-bad)' },
    { key: 'running', n: 0, color: 'var(--aviary-info)' },
  ];
  type Outcome = (typeof outcomes)[number];
  const name = (o: Outcome) => o.key;
  const count = (o: Outcome) => o.n;
  const tone = (o: Outcome) => o.color;

  it('renders a named, focusable chart with its centre label', () => {
    render(
      <DonutChart
        data={outcomes}
        label={name}
        value={count}
        color={tone}
        ariaLabel="run outcomes"
        centerLabel="40"
        centerSub="runs"
      />,
    );
    const surface = screen.getByRole('img', { name: 'run outcomes' });
    expect(surface.getAttribute('tabindex')).toBe('0');
    expect(screen.getByText('40')).toBeTruthy();
    expect(screen.getByText('runs')).toBeTruthy();
  });

  it('shows the slice name, formatted value and share on keyboard focus', async () => {
    render(
      <DonutChart
        data={outcomes}
        label={name}
        value={count}
        color={tone}
        valueLabel="runs"
        formatValue={(n) => `${n} runs`}
        ariaLabel="run outcomes"
      />,
    );
    await focusChart('run outcomes');
    // focus lands on one slice; whichever it is, the tooltip carries its value and share
    const text = tooltipText();
    expect(
      (text.includes('completed') && text.includes('30 runs') && text.includes('75%')) ||
        (text.includes('failed') && text.includes('10 runs') && text.includes('25%')),
    ).toBe(true);
    expect(text).toContain('share');
  });

  it('renders the empty state when the total is zero', () => {
    render(
      <DonutChart
        data={outcomes.map((o) => ({ ...o, n: 0 }))}
        label={name}
        value={count}
        ariaLabel="run outcomes"
        empty="No runs."
      />,
    );
    expect(screen.queryByRole('img', { name: 'run outcomes' })).toBeNull();
    expect(screen.getByText('No runs.')).toBeTruthy();
  });
});
