---
"@dudousxd/nestjs-telescope-otel": major
---

**Breaking:** `TelescopeOtelMetricsModule.forExporter(exporter, { decorators })` takes class decorators for the `GET /metrics` controller, applied to a fresh subclass per call; the controller is also marked open to `@nestjs/authorization`'s deny-by-default global guard, and a `Can()` passed in `decorators` is still enforced. `decorators` apply in every environment whenever given.

**Production:** by default `/metrics` stays **outside** the console's production rule, so an undecorated scrape still boots with `NODE_ENV=production` (a Prometheus scrape usually runs unauthenticated inside the cluster). `/metrics` exposes your metrics: keep it reachable only by the scraper, with a network policy or `decorators`. The new `requireProtectionInProduction: true` (default `false`) puts it under the same rule as the console: in production, mounting it with no `decorators` (an empty array counts as none) fails the boot. `routes: false` always boots.

Requires `@dudousxd/nestjs-telescope@2` (the peer moves to `^2`). Migration: nothing, unless you want the scrape protected: pass `decorators: [UseGuards(AuthenticationGuard), Can(MetricsPolicy, 'scrape')]` (optionally with `requireProtectionInProduction: true`), or use `routes: false` and serve the scrape from your own controller.
