---
"@dudousxd/nestjs-telescope-otel": minor
---

Export everything Telescope records to OpenTelemetry/Grafana. `TelescopeOtelExporter` (a `TelescopeExtension`) pushes **complete** metrics (counted pre-sampling) into the OTel Meter for OTLP and a dependency-free Prometheus `/metrics` scrape (`TelescopeOtelMetricsModule.forExporter`), and **sampled** spans into the OTel Tracer. Durations export as real Prometheus histograms (`_bucket{le}` + `_sum`/`_count`) with boundaries aligned to the OTel Meter, so `histogram_quantile` works in Grafana. Metric cardinality is bounded per metric (`maxSeriesPerMetric`, default 2000) with a visible `telescope_metrics_dropped_series_total{metric}` instead of unbounded growth. `@nestjs/common` and `@nestjs/core` are optional peers (only the `/metrics` module needs them; the exporter itself is NestJS-free).
