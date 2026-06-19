import { describe, expect, it } from 'vitest';
import { TelescopeOtelExporter } from './telescope-otel-exporter.js';
import { TelescopeOtelMetricsController } from './metrics.controller.js';

describe('TelescopeOtelMetricsController', () => {
  it('serves the exporter Prometheus text', () => {
    const exporter = new TelescopeOtelExporter();
    exporter.observeRecord({ type: 'request', content: { method: 'GET', statusCode: 200 } });
    const controller = new TelescopeOtelMetricsController(exporter);
    expect(controller.metrics()).toContain('telescope_requests_total');
  });
});
