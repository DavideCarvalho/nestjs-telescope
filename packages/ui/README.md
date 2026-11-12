# @dudousxd/nestjs-telescope-ui

A visual dashboard for [`@dudousxd/nestjs-telescope`](../../README.md) — a bundled
React SPA served by a NestJS module. **No frontend dependency is imposed on your
app:** React + Tailwind are bundled into static assets at publish time; your app
just serves them. Works on Express and Fastify.

## Turnkey dashboard

```ts
import { Module } from '@nestjs/common';
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { TelescopeUiModule } from '@dudousxd/nestjs-telescope-ui';

@Module({
  imports: [TelescopeModule.forRoot(), TelescopeUiModule.forRoot()],
})
export class AppModule {}
```

Open `/telescope`. The dashboard polls `/telescope/api/*` and shows captured
entries (type tabs + live polling) and, on an entry, the correlated batch — the
request and everything it caused.

### Protecting the page

`authorize` decides who may open the page, the same option (and usually the
same value) as on `TelescopeModule`:

```ts
TelescopeUiModule.forRoot({
  authorize: (ctx) => ctx.switchToHttp().getRequest().user?.isAdmin === true,
});

// or mount it yourself: routes: false + your own subclass. List
// @UseConsoleAuthorize() ABOVE your auth guard so the guard runs first;
// with no argument it runs TelescopeModule.forRoot({ authorize }).
@Controller('ops/telescope')
@UseConsoleAuthorize()
@UseGuards(AuthGuard)
class ConsolePage extends TelescopeUiController {}
// imports: [TelescopeUiModule.forRoot({ path: 'ops/telescope', routes: false })]
```

A denied navigation gets an "Access denied" page (403), a "Sign in required"
page (401), or a 302 when the check returns `{ redirectTo: '/login' }`. A full-page navigation carries your cookies,
not an `Authorization` header, so check a session here. In the running
dashboard, a 401 with `redirectTo` from the API is followed and a 403 shows an
access-denied screen. Set `path` to the mount: the page rebases its asset URLs
on it.

Without `authorize` the page is open outside production; with
`NODE_ENV === 'production'` it answers 403 and one warning is logged at boot.
`decorators` (e.g. `[UseGuards(AuthenticationGuard)]`) still run first. See
[Protecting the routes](../../README.md#protecting-the-routes).

To link to the console from your app, `telescopeConsoleUrl(basePath)` (from
`@dudousxd/nestjs-telescope-ui/client`) gives its URL.

## Build your own (composable)

The same pieces are exported so you can drop them into your own admin:

```tsx
import { TelescopeProvider, useEntries, EntriesTable } from '@dudousxd/nestjs-telescope-ui/react';

function MyEntries() {
  const { data } = useEntries({ type: 'query' });
  return <EntriesTable entries={data?.data ?? []} />;
}
// wrap your tree once in <TelescopeProvider> (defaults to the /telescope/api base)
```

Or just the typed client (no React):

```ts
import { createTelescopeClient } from '@dudousxd/nestjs-telescope-ui/client';
const telescope = createTelescopeClient({ baseUrl: '/telescope/api' });
const page = await telescope.entries({ type: 'job' });
```

## Peer dependencies

`.` (the module) needs `@nestjs/common` / `@nestjs/core` (>= 11). `/react` needs
`react`, `react-dom`, `@tanstack/react-query` (only if you import it — they're
optional peers). The turnkey dashboard bundles its own copies.
