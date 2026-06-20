import { describe, expect, it } from 'vitest';
import { mapInput, MetricStore } from './instrument-map.js';

describe('mapInput', () => {
  it('maps a request to a counter + duration metric with method/status labels', () => {
    const s = mapInput({
      type: 'request',
      content: { method: 'GET', statusCode: 200 },
      durationMs: 12,
    });
    expect(s).toEqual({
      counter: 'telescope_requests_total',
      labels: { method: 'GET', status: '200' },
      durationMs: 12,
      durationMetric: 'telescope_request_duration_ms',
    });
  });

  it('maps an exception to a counter labelled by class', () => {
    const s = mapInput({ type: 'exception', content: { class: 'TypeError' } });
    expect(s?.counter).toBe('telescope_exceptions_total');
    expect(s?.labels).toEqual({ class: 'TypeError' });
  });

  it('maps a diagnostic entry to the generic counter with lib/event labels', () => {
    const s = mapInput({
      type: 'diagnostic',
      content: { lib: 'authz', event: 'decision' },
    });
    expect(s).toEqual({
      counter: 'telescope_diagnostic_total',
      labels: { lib: 'authz', event: 'decision' },
      durationMs: null,
    });
  });

  it('returns null for an unmapped type', () => {
    expect(mapInput({ type: 'dump', content: {} })).toBeNull();
  });
});

describe('MetricStore.prometheus', () => {
  it('emits counter totals and duration sum/count', () => {
    const store = new MetricStore();
    store.add({ counter: 'telescope_requests_total', labels: { method: 'GET', status: '200' }, durationMs: 10, durationMetric: 'telescope_request_duration_ms' });
    store.add({ counter: 'telescope_requests_total', labels: { method: 'GET', status: '200' }, durationMs: 30, durationMetric: 'telescope_request_duration_ms' });
    const text = store.prometheus();
    expect(text).toContain('telescope_requests_total{method="GET",status="200"} 2');
    expect(text).toContain('telescope_request_duration_ms_sum{method="GET",status="200"} 40');
    expect(text).toContain('telescope_request_duration_ms_count{method="GET",status="200"} 2');
  });
});
