import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChartLegendContent, ChartTooltipContent } from './chart.js';

/**
 * The tooltip and legend bodies are plain components that Recharts hands a
 * payload — so they are rendered directly here with the payloads Recharts
 * actually produces. Driving them through a real hover would test jsdom's
 * (nonexistent) layout, not the formatting, which is the part that breaks.
 */

describe('ChartTooltipContent', () => {
  it('renders nothing until the tooltip is active with a payload', () => {
    const { container } = render(
      <ChartTooltipContent payload={[{ dataKey: 'value', value: 1 }]} />,
    );
    expect(container.firstChild).toBeNull();
    const empty = render(<ChartTooltipContent active payload={[]} />);
    expect(empty.container.firstChild).toBeNull();
  });

  it('shows the label row and one row per series', () => {
    render(
      <ChartTooltipContent
        active
        label="12:00"
        payload={[
          { dataKey: 'request', name: 'request', value: 12, color: '#34d399' },
          { dataKey: 'query', name: 'query', value: 3, color: '#38bdf8' },
        ]}
      />,
    );
    expect(screen.getByText('12:00')).toBeTruthy();
    expect(screen.getByText('request')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('formats values through valueFormatter and labels through labelFormatter', () => {
    render(
      <ChartTooltipContent
        active
        label="p99"
        labelFormatter={(l) => l.toUpperCase()}
        valueFormatter={(v) => `${v}ms`}
        payload={[{ dataKey: 'value', name: 'latency', value: 1200 }]}
      />,
    );
    expect(screen.getByText('P99')).toBeTruthy();
    expect(screen.getByText('1200ms')).toBeTruthy();
  });

  it('survives a payload that is not the shape Recharts documents', () => {
    // A provider can return anything; the guards must degrade to "—" rather than
    // render `[object Object]` or throw inside a chart nobody can then use.
    render(
      <ChartTooltipContent active payload={[{ dataKey: 'value', value: { nested: true } }]} />,
    );
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('ignores a payload that is not an array at all', () => {
    const { container } = render(<ChartTooltipContent active payload={{ value: 1 }} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('ChartLegendContent', () => {
  const payload = [
    { dataKey: 'request', value: 'request', color: '#34d399' },
    { dataKey: 'query', value: 'query', color: '#38bdf8' },
  ];

  it('renders plain labels when no toggle handler is wired', () => {
    render(<ChartLegendContent payload={payload} />);
    expect(screen.getByText('request')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a pressed toggle per series and reports the one clicked', () => {
    const onToggle = vi.fn<(key: string) => void>();
    render(
      <ChartLegendContent payload={payload} hidden={new Set(['query'])} onToggle={onToggle} />,
    );

    const request = screen.getByRole('button', { name: /request/ });
    const query = screen.getByRole('button', { name: /query/ });
    expect(request.getAttribute('aria-pressed')).toBe('true');
    expect(query.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(query);
    expect(onToggle).toHaveBeenCalledWith('query');
  });

  it('keys pie sectors off `value`, which is the only name they carry', () => {
    // Pie legend entries have no dataKey and no name — the series name is in
    // `value`. Reusing the tooltip's key lookup left a donut's legend blank.
    render(<ChartLegendContent payload={[{ value: 'failed', color: '#f87171' }]} />);
    expect(screen.getByText('failed')).toBeTruthy();
  });
});
