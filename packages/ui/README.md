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
