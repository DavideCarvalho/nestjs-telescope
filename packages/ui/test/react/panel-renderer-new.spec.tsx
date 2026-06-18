// packages/ui/test/react/panel-renderer-new.spec.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PanelView } from '../../src/react/components/extensions/panel-renderer.js';

describe('PanelView new kinds', () => {
  it('passes delta + spark into StatCard for enriched stat', () => {
    render(
      <PanelView
        panel={{
          kind: 'stat',
          title: 'Success',
          data: { provider: 'p' },
          format: 'percent',
          spark: true,
          thresholds: { warn: 0.95, bad: 0.9, direction: 'down-bad' },
        }}
        data={{ value: 0.987, delta: 0.012, deltaLabel: '1.2pp', spark: [0.9, 0.95, 0.98] }}
      />,
    );
    expect(screen.getByText(/1\.2pp/)).toBeTruthy();
  });

  it('renders a distribution panel', () => {
    expect(() =>
      render(
        <PanelView
          panel={{ kind: 'distribution', title: 'Dur', data: { provider: 'p' }, markers: ['p95'] }}
          data={{ buckets: [{ label: '0-1s', count: 4 }], p95: 1400 }}
        />,
      ),
    ).not.toThrow();
  });

  it('renders rate-format stat with /hr unit', () => {
    render(
      <PanelView
        panel={{ kind: 'stat', title: 'Throughput', data: { provider: 'p' }, format: 'rate' }}
        data={{ value: 340 }}
      />,
    );
    expect(screen.getByText(/\/hr/)).toBeTruthy();
  });
});
