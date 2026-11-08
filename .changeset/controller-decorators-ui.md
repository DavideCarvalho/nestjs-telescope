---
"@dudousxd/nestjs-telescope-ui": major
---

**Breaking:** the page is now protected only with `@nestjs/authentication` + `@nestjs/authorization`. Add a `decorators` option to `TelescopeUiModule.forRoot` / `forRootAsync` (static top-level on the async variant): the class decorators go on the dashboard controller, which is also marked open to `@nestjs/authorization`'s deny-by-default global guard; a `Can()` passed in `decorators` is still enforced. With `NODE_ENV=production`, mounting the page with no `decorators` (an empty array counts as none) fails the boot (the rule checks that decorators are present, not that they enforce auth); `routes: false` always boots.

Removed: the `guards` and `dashboardAuth` options (and `unauthenticatedPage`), the SPA's sign-in screen, sign-out button and `client.auth.*` methods, `meta.auth` in the client types, and the session-minting console launcher (`openTelescopeConsole`, `mintTelescopeConsoleSession`, `telescopeConsoleSessionUrl`, `ConsoleSessionError`, `useOpenTelescopeConsole`, `openTelescopeConsoleMutationOptions`, `<OpenTelescopeConsoleButton>` and the `./react/console` subpath). `telescopeConsoleUrl` stays in `./client`.

Migration: `guards: [G]` → `decorators: [UseGuards(G), Can(Policy, 'view')]` (pass the same list to `TelescopeModule`); `dashboardAuth` → your app's own sign-in through `@nestjs/authentication` (the page authenticates from your app's cookie); the launcher → a plain link to `telescopeConsoleUrl(basePath)`.
