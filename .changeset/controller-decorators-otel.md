---
"@dudousxd/nestjs-telescope-otel": minor
---

**Breaking:** `TelescopeOtelMetricsModule.forExporter(exporter, { decorators })` takes class decorators for the `GET /metrics` controller, applied to a fresh subclass per call; the controller is also marked open to `@nestjs/authorization`'s deny-by-default global guard, and a `Can()` passed in `decorators` is still enforced. With `NODE_ENV=production`, mounting the scrape with no `decorators` (an empty array counts as none) now fails the boot, the same rule as the console's.

Migration: in production pass `decorators: [UseGuards(AuthenticationGuard), Can(MetricsPolicy, 'scrape')]`, or use `routes: false` and serve the scrape from your own controller.
