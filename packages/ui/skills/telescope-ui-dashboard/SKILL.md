---
name: telescope-ui-dashboard
description: >-
  Serve and embed the nestjs-telescope dashboard with @dudousxd/nestjs-telescope-ui.
  Mount the bundled React SPA via TelescopeUiModule.forRoot({ path?, assetsDir? }) /
  forRootAsync (the path must match TelescopeModule and is static in the async form);
  call the headless API from any frontend with createTelescopeClient({ baseUrl?,
  fetch? }) from the /client subpath; build a custom console with the React
  components, hooks (TelescopeProvider, useTelescopeClient, useEntries, usePulse,
  useTimeseries) from the /react subpath. Use for "show the Telescope dashboard",
  "custom path", "call the Telescope API from React", "embed Telescope components".
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-telescope-ui"
  library_version: "1.12.0"
  framework: nestjs
---

# Dashboard UI & client

`@dudousxd/nestjs-telescope-ui` serves a bundled React SPA from a NestJS module —
no frontend dependency is imposed on your app. It also ships a framework-agnostic
`createTelescopeClient` (`/client`) and composable React components/hooks
(`/react`) for building your own console.

## Setup

Import the UI module alongside the core module. The `path` must match
`TelescopeModule` (default `telescope`):

```ts
import { Module } from '@nestjs/common';
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { TelescopeUiModule } from '@dudousxd/nestjs-telescope-ui';

@Module({
  imports: [
    TelescopeModule.forRoot({ enabled: true, authorizer: () => true }),
    TelescopeUiModule.forRoot(), // dashboard at /telescope
  ],
})
export class AppModule {}
```

Source: `packages/ui/src/server/telescope-ui.module.ts`,
`packages/ui/src/server/telescope-ui.options.ts` (`TelescopeUiModuleOptions`).

## Core patterns

### Pattern 1 — a custom mount path

Set the same `path` on BOTH modules. In `forRootAsync` the `path` is a static
sibling of `useFactory`, not returned from it.

```ts
TelescopeModule.forRoot({ path: 'observability', enabled: true, authorizer: () => true });
TelescopeUiModule.forRoot({ path: 'observability' }); // dashboard now at /observability
```

```ts
// async form: path stays static
TelescopeUiModule.forRootAsync({
  path: 'observability',
  useFactory: () => ({}),
});
```

Source: `packages/ui/src/server/telescope-ui.module.ts`,
`packages/ui/src/server/telescope-ui.options.ts`.

### Pattern 2 — call the headless API with the client

`createTelescopeClient` (from the `/client` subpath) is a typed wrapper over the
JSON API, usable in any frontend. `baseUrl` defaults to
`window.__TELESCOPE_BASE__ + '/api'`, else `/telescope/api`.

```ts
import { createTelescopeClient } from '@dudousxd/nestjs-telescope-ui/client';

const client = createTelescopeClient({ baseUrl: '/observability/api' });
const page = await client.entries({ type: 'exception' });
const detail = await client.entry(page.data[0].id); // entry + its correlated batch
const pulse = await client.pulse('1h');
```

Source: `packages/ui/src/client/telescope-client.ts` (`createTelescopeClient`,
`TelescopeClient`, `TelescopeClientOptions`).

### Pattern 3 — build a custom console with React hooks

Wrap your tree in `TelescopeProvider`, then read with the query hooks from the
`/react` subpath.

```tsx
import {
  TelescopeProvider,
  useEntries,
  usePulse,
} from '@dudousxd/nestjs-telescope-ui/react';
import { createTelescopeClient } from '@dudousxd/nestjs-telescope-ui/client';

function ExceptionList() {
  const { data } = useEntries({ type: 'exception' });
  return <ul>{data?.data.map((e) => <li key={e.id}>{e.id}</li>)}</ul>;
}

export function App() {
  return (
    <TelescopeProvider client={createTelescopeClient({ baseUrl: '/telescope/api' })}>
      <ExceptionList />
    </TelescopeProvider>
  );
}
```

Source: `packages/ui/src/react/telescope-context.tsx` (`TelescopeProvider`,
`useTelescopeClient`), `packages/ui/src/react/use-telescope-queries.ts`
(`useEntries`, `usePulse`, `useTimeseries`).

## Common mistakes

### Mistake 1 — mismatched paths between the two modules

```ts
// Wrong — the SPA loads but its API calls 404: core API is at /observability/api,
// the dashboard probes /telescope/api.
TelescopeModule.forRoot({ path: 'observability', enabled: true, authorizer: () => true });
TelescopeUiModule.forRoot(); // defaults to 'telescope'
```

```ts
// Correct — both modules share the same path.
TelescopeModule.forRoot({ path: 'observability', enabled: true, authorizer: () => true });
TelescopeUiModule.forRoot({ path: 'observability' });
```

Mechanism: the UI controller injects the mount base so the SPA derives its API base
from it; if the core API lives elsewhere every request misses. Source:
`packages/ui/src/server/telescope-ui.options.ts`,
`packages/ui/src/client/telescope-client.ts` (`defaultBaseUrl`).

### Mistake 2 — importing components from the package root

```ts
// Wrong — the root export is the NestJS server module, not React; this fails.
import { TelescopeProvider } from '@dudousxd/nestjs-telescope-ui';
```

```ts
// Correct — React surface lives under /react, the client under /client.
import { TelescopeProvider } from '@dudousxd/nestjs-telescope-ui/react';
import { createTelescopeClient } from '@dudousxd/nestjs-telescope-ui/client';
```

Mechanism: the package has three entry points — `.` (server module), `./react`,
and `./client` — so frontend code must import from the subpaths. Source:
`packages/ui/package.json` (`exports`), `packages/ui/src/react/index.ts`.

### Mistake 3 — using a query hook outside `TelescopeProvider`

```tsx
// Wrong — useEntries calls useTelescopeClient, which throws with no provider.
function App() {
  const { data } = useEntries(); // Error: must be used within a TelescopeProvider
  return null;
}
```

```tsx
// Correct — wrap the tree in TelescopeProvider first.
function Root() {
  return (
    <TelescopeProvider>
      <App />
    </TelescopeProvider>
  );
}
```

Mechanism: the hooks resolve the client from React context; `useTelescopeClient`
throws "must be used within a TelescopeProvider" when the context is missing.
Source: `packages/ui/src/react/telescope-context.tsx` (`useTelescopeClient`).
