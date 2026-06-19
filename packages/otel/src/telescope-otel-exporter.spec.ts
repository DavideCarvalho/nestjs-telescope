import { describe, expect, it } from 'vitest';
import { TelescopeOtelExporter } from './telescope-otel-exporter.js';

describe('TelescopeOtelExporter.observeRecord', () => {
  it('is a TelescopeExtension named otel-export', () => {
    const exporter = new TelescopeOtelExporter();
    expect(exporter.name).toBe('otel-export');
    expect(typeof exporter.observeRecord).toBe('function');
  });

  it('aggregates records into the Prometheus exposition', () => {
    const exporter = new TelescopeOtelExporter();
    exporter.observeRecord({ type: 'request', content: { method: 'GET', statusCode: 200 }, durationMs: 5 });
    exporter.observeRecord({ type: 'request', content: { method: 'GET', statusCode: 200 }, durationMs: 7 });
    const text = exporter.prometheus();
    expect(text).toContain('telescope_requests_total{method="GET",status="200"} 2');
  });

  it('ignores unmapped types', () => {
    const exporter = new TelescopeOtelExporter();
    exporter.observeRecord({ type: 'dump', content: {} });
    expect(exporter.prometheus()).toBe('');
  });
});
