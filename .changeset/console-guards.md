---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

First-class `guards` (+ `imports`) options for the Telescope console, mirroring `@dudousxd/nestjs-agent`'s dashboard module: `TelescopeModule.forRoot`/`forRootAsync` and `TelescopeUiModule.forRoot`/`forRootAsync` now accept `guards: Array<Type<CanActivate> | CanActivate>` fronting the console's controllers, plus `imports` resolving a class guard's own dependencies.

This closes the auth seam for hosts with header-only auth: a full-page navigation to the dashboard carries no `Authorization` header, so there was previously no way to hang a cookie/session guard on the page itself. Pass the SAME `guards` (and `imports`) to both modules — they're independent options in separate packages. On core, `guards` **appends** to (never replaces) the existing `TelescopeGuard` gate (`authorizer` / `dashboardAuth` / dev-open-prod-closed default); on `-ui`, `TelescopeUiController` had no guard of its own, so it's a plain replace. See the new "Securing the console with your own guards" docs section.
