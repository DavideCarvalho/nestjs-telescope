---
"@dudousxd/nestjs-telescope-otel": minor
---

`TelescopeOtelMetricsModule.forExporter(exporter, { decorators })` takes class decorators for the `GET /metrics` controller, applied to a fresh subclass per call. The controller is now also marked open to `@nestjs/authorization`'s deny-by-default global guard, so the scrape keeps answering when an app adopts that package. A `Can()` passed in `decorators` is still enforced.
