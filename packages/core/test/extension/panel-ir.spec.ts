import { describe, expect, it } from 'vitest';
import { defineTelescopeExtension } from '../../src/extension/types.js';

describe('panel IR additions', () => {
  it('accepts enriched stat + new panel kinds + sections', () => {
    const ext = defineTelescopeExtension({
      name: 'demo',
      dashboards: () => [
        {
          id: 'demo.page',
          label: 'Demo',
          sections: [
            {
              title: 'Health',
              cols: 4,
              panels: [
                {
                  kind: 'stat',
                  title: 'Success',
                  data: { provider: 'demo.success' },
                  format: 'percent',
                  spark: true,
                  thresholds: { warn: 0.95, bad: 0.9, direction: 'down-bad' },
                },
                { kind: 'gauge', title: 'Sat', data: { provider: 'demo.sat' }, max: 1 },
              ],
            },
            {
              title: 'Trends',
              cols: 2,
              panels: [
                {
                  kind: 'distribution',
                  title: 'Duration',
                  data: { provider: 'demo.dur' },
                  markers: ['p50', 'p95', 'p99'],
                  format: 'duration',
                },
                {
                  kind: 'breakdown',
                  title: 'States',
                  data: { provider: 'demo.states' },
                  style: 'donut',
                },
              ],
            },
          ],
          panels: [],
        },
      ],
    });
    const dash = ext.dashboards?.({} as never)[0];
    expect(dash?.sections?.[0].panels[0].kind).toBe('stat');
    expect(dash?.sections?.[1].panels[0].kind).toBe('distribution');
  });

  it('accepts a table panel opting into the paged convention', () => {
    const ext = defineTelescopeExtension({
      name: 'demo',
      dashboards: () => [
        {
          id: 'demo.paged',
          label: 'Demo',
          panels: [
            {
              kind: 'table',
              title: 'Runs',
              data: { provider: 'demo.runs' },
              columns: [{ key: 'runId', label: 'Run' }],
              paged: true,
            },
            {
              kind: 'table',
              title: 'Recent',
              data: { provider: 'demo.recent' },
              columns: [{ key: 'runId', label: 'Run' }],
            },
          ],
        },
      ],
    });
    const dash = ext.dashboards?.({} as never)[0];
    const [pagedPanel, unpagedPanel] = dash?.panels ?? [];
    expect(pagedPanel?.kind).toBe('table');
    expect(pagedPanel?.kind === 'table' && pagedPanel.paged).toBe(true);
    // Non-paged tables don't declare the field at all — convention default is "off".
    expect(unpagedPanel?.kind === 'table' && unpagedPanel.paged).toBeUndefined();
  });
});
