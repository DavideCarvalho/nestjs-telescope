---
"@dudousxd/nestjs-telescope": minor
---

Add a `decorators` option to `TelescopeModule.forRoot` / `forRootAsync` (a static top-level option on the async variant). The class decorators go on every controller the module mounts (API, SSE stream, auth, client errors, MCP), e.g. `[UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')]`. Each controller is now also marked open to `@nestjs/authorization`'s deny-by-default global `AuthorizationGuard` (the `Can.Anyone()` mark), so the console keeps answering when an app adopts that package. A `Can()` passed in `decorators` is still enforced. Every registration gets fresh controller subclasses, so decorators don't leak between registrations. `dynamicController` takes an optional `decorators` argument, and `applyControllerDecorators` is now exported.
