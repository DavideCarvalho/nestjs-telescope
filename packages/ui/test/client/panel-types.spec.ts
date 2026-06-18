import { describe, expect, it } from 'vitest';
import type { DashboardSection, Panel, PanelThresholds } from '../../src/client/types.js';

describe('ui Panel mirror', () => {
  it('has the new kinds', () => {
    const kinds: Panel['kind'][] = [
      'stat',
      'timeseries',
      'topN',
      'table',
      'distribution',
      'gauge',
      'breakdown',
    ];
    expect(kinds).toContain('distribution');
    const p: Panel = { kind: 'gauge', title: 'x', data: { provider: 'p' }, max: 1 };
    expect(p.kind).toBe('gauge');
  });

  it('supports gauge panels with thresholds', () => {
    const thresholds: PanelThresholds = {
      warn: 50,
      bad: 80,
      direction: 'up-bad',
    };
    const p: Panel = {
      kind: 'gauge',
      title: 'Request Rate',
      data: { provider: 'metrics.requests' },
      min: 0,
      max: 100,
      format: 'number',
      thresholds,
    };
    expect(p.kind).toBe('gauge');
  });

  it('supports distribution panels', () => {
    const p: Panel = {
      kind: 'distribution',
      title: 'Response Times',
      data: { provider: 'metrics.latency' },
      markers: ['p50', 'p95', 'p99'],
      format: 'duration',
    };
    expect(p.kind).toBe('distribution');
  });

  it('supports breakdown panels', () => {
    const p: Panel = {
      kind: 'breakdown',
      title: 'Error Breakdown',
      data: { provider: 'errors.breakdown' },
      style: 'donut',
    };
    expect(p.kind).toBe('breakdown');
  });

  it('DashboardSection has correct structure', () => {
    const section: DashboardSection = {
      title: 'Performance',
      cols: 3,
      panels: [{ kind: 'stat', title: 'QPS', data: { provider: 'metrics.qps' } }],
    };
    expect(section.title).toBe('Performance');
    expect(section.cols).toBe(3);
  });
});
