---
"@dudousxd/nestjs-telescope-ui": minor
---

Add a `decorators` option to `TelescopeUiModule.forRoot` / `forRootAsync` (a static top-level option on the async variant). The class decorators go on the dashboard controller. The controller is now also marked open to `@nestjs/authorization`'s deny-by-default global guard, so the page keeps loading when an app adopts that package. A `Can()` passed in `decorators` is still enforced.
