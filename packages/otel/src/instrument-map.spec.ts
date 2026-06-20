import { describe, expect, it } from 'vitest';
import { MetricStore, mapInput } from './instrument-map.js';

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
    store.add({
      counter: 'telescope_requests_total',
      labels: { method: 'GET', status: '200' },
      durationMs: 10,
      durationMetric: 'telescope_request_duration_ms',
    });
    store.add({
      counter: 'telescope_requests_total',
      labels: { method: 'GET', status: '200' },
      durationMs: 30,
      durationMetric: 'telescope_request_duration_ms',
    });
    const text = store.prometheus();
    expect(text).toContain('telescope_requests_total{method="GET",status="200"} 2');
    expect(text).toContain('telescope_request_duration_ms_sum{method="GET",status="200"} 40');
    expect(text).toContain('telescope_request_duration_ms_count{method="GET",status="200"} 2');
  });
});

describe('MetricStore Prometheus histogram + headers', () => {
  it('emits # TYPE/# HELP and cumulative histogram buckets for durations', () => {
    const store = new MetricStore({ durationBucketsMs: [10, 100] });
    store.add({
      counter: 'telescope_requests_total',
      labels: { method: 'GET', status: '200' },
      durationMs: 5,
      durationMetric: 'telescope_request_duration_ms',
    });
    store.add({
      counter: 'telescope_requests_total',
      labels: { method: 'GET', status: '200' },
      durationMs: 50,
      durationMetric: 'telescope_request_duration_ms',
    });
    const text = store.prometheus();
    expect(text).toContain('# TYPE telescope_requests_total counter');
    expect(text).toContain('# TYPE telescope_request_duration_ms histogram');
    // 5 <= 10 and <= 100; 50 > 10 but <= 100 -> le=10:1, le=100:2, +Inf:2 (cumulative)
    expect(text).toContain(
      'telescope_request_duration_ms_bucket{method="GET",status="200",le="10"} 1',
    );
    expect(text).toContain(
      'telescope_request_duration_ms_bucket{method="GET",status="200",le="100"} 2',
    );
    expect(text).toContain(
      'telescope_request_duration_ms_bucket{method="GET",status="200",le="+Inf"} 2',
    );
    expect(text).toContain('telescope_request_duration_ms_sum{method="GET",status="200"} 55');
    expect(text).toContain('telescope_request_duration_ms_count{method="GET",status="200"} 2');
  });

  it('emits buckets with only le when the series carries no other labels', () => {
    const store = new MetricStore({ durationBucketsMs: [10] });
    store.add({ counter: 'x_total', labels: {}, durationMs: 5, durationMetric: 'x_ms' });
    const text = store.prometheus();
    expect(text).toContain('x_ms_bucket{le="10"} 1');
    expect(text).toContain('x_ms_bucket{le="+Inf"} 1');
  });

  it('sorts caller-provided buckets so the le series stay monotonic', () => {
    const store = new MetricStore({ durationBucketsMs: [100, 10] }); // out of order on purpose
    store.add({ counter: 'x_total', labels: {}, durationMs: 50, durationMetric: 'x_ms' });
    const text = store.prometheus();
    const idx10 = text.indexOf('x_ms_bucket{le="10"}');
    const idx100 = text.indexOf('x_ms_bucket{le="100"}');
    expect(idx10).toBeGreaterThanOrEqual(0);
    expect(idx10).toBeLessThan(idx100); // ascending le in the exposition
    expect(text).toContain('x_ms_bucket{le="10"} 0'); // 50 > 10
    expect(text).toContain('x_ms_bucket{le="100"} 1'); // 50 <= 100
  });
});

describe('MetricStore cardinality cap', () => {
  it('drops new series past the per-metric cap and surfaces the drop count', () => {
    const store = new MetricStore({ maxSeriesPerMetric: 2 });
    store.add({ counter: 'telescope_http_client_total', labels: { host: 'a' }, durationMs: null });
    store.add({ counter: 'telescope_http_client_total', labels: { host: 'b' }, durationMs: null });
    store.add({ counter: 'telescope_http_client_total', labels: { host: 'c' }, durationMs: null }); // over cap -> dropped
    store.add({ counter: 'telescope_http_client_total', labels: { host: 'a' }, durationMs: null }); // existing -> still counts
    const text = store.prometheus();
    expect(text).toContain('telescope_http_client_total{host="a"} 2');
    expect(text).toContain('telescope_http_client_total{host="b"} 1');
    expect(text).not.toContain('host="c"');
    expect(text).toContain(
      'telescope_metrics_dropped_series_total{metric="telescope_http_client_total"} 1',
    );
  });
});
