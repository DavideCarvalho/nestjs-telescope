---
"@dudousxd/nestjs-telescope-otel": major
---

`TelescopeOtelMetricsModule.forExporter(exporter, { routes: false })` mounts no controller and exports the exporter under `TELESCOPE_OTEL_EXPORTER`, so your own controller (a subclass of `TelescopeOtelMetricsController`, or one calling `exporter.prometheus()`) serves the scrape behind `@Can(...)` / `@UseGuards(...)`.
