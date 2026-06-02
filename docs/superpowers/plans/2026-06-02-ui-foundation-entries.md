# Telescope UI — Foundation + Entries Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundation of `@dudousxd/nestjs-telescope-ui` — a bundled React SPA served by a NestJS controller — plus a working **Entries** dashboard (list with type tabs + polling, and an entry-detail view showing the correlated batch). This proves the whole pipeline end-to-end; Pulse + Queues views are a follow-up plan.

**Architecture:** See `docs/superpowers/specs/2026-06-02-telescope-ui-design.md`. Layered package: `src/client` (framework-agnostic typed API client) → `src/react` (TanStack Query hooks + components) → `src/app` (the bundled SPA, Vite → `dist/spa`) and `src/server` (the Nest module serving the bundle, tsc → `dist/server`). Exports: `.` = server module, `./react` = hooks+components+client, `./client` = client only. Hash routing; polling; dark Tailwind console; no host frontend deps (we bundle at publish time).

**Tech Stack:** React 18, Vite 5, Tailwind 3, TanStack Query 5, react-router 6 (hash), NestJS 11, vitest (+ jsdom + @testing-library/react for the react layer), biome, pnpm+turbo, changesets.

---

## Task 1: Scaffold the `@dudousxd/nestjs-telescope-ui` package (build pipeline)

The riskiest task: a Vite app build + two tsc lib builds coexisting in `dist/`. A trivial app that fetches `/telescope/api/meta` proves the pipeline.

**Files (all new under `packages/ui/`):** `package.json`, `tsconfig.json` (app/editor), `tsconfig.server.json`, `tsconfig.lib.json`, `vite.config.ts`, `vitest.config.ts`, `tailwind.config.ts`, `postcss.config.cjs`, `index.html`, `src/app/main.tsx`, `src/app/App.tsx`, `src/app/index.css`, `src/server/index.ts` (stub re-export), `src/client/index.ts` (stub), `src/react/index.ts` (stub). Modify `.changeset/config.json` (add package to `linked`).

- [ ] **Step 1: `packages/ui/package.json`**

```json
{
  "name": "@dudousxd/nestjs-telescope-ui",
  "version": "0.0.0",
  "description": "Bundled dashboard + composable React components for @dudousxd/nestjs-telescope.",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/DavideCarvalho/nestjs-telescope.git", "directory": "packages/ui" },
  "author": "Davi Carvalho <davi@goflip.ai>",
  "type": "module",
  "main": "./dist/server/index.js",
  "types": "./dist/server/index.d.ts",
  "exports": {
    ".": { "types": "./dist/server/index.d.ts", "import": "./dist/server/index.js", "default": "./dist/server/index.js" },
    "./react": { "types": "./dist/react/index.d.ts", "import": "./dist/react/index.js", "default": "./dist/react/index.js" },
    "./client": { "types": "./dist/client/index.d.ts", "import": "./dist/client/index.js", "default": "./dist/client/index.js" }
  },
  "files": ["dist/", "README.md", "CHANGELOG.md"],
  "scripts": {
    "build": "vite build && tsc -p tsconfig.lib.json && tsc -p tsconfig.server.json",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.lib.json --noEmit && tsc -p tsconfig.server.json --noEmit"
  },
  "peerDependencies": {
    "@dudousxd/nestjs-telescope": "workspace:*",
    "@nestjs/common": ">=10.0.0",
    "@nestjs/core": ">=10.0.0"
  },
  "peerDependenciesMeta": {
    "react": { "optional": true },
    "react-dom": { "optional": true },
    "@tanstack/react-query": { "optional": true }
  },
  "devDependencies": {
    "@dudousxd/nestjs-telescope": "workspace:*",
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@nestjs/testing": "^11.0.0",
    "@tanstack/react-query": "^5.0.0",
    "@testing-library/react": "^16.0.0",
    "@types/node": "^20.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/supertest": "^6.0.2",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "jsdom": "^25.0.0",
    "postcss": "^8.4.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0",
    "reflect-metadata": "^0.2.2",
    "supertest": "^7.0.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.4.0",
    "vite": "^5.4.0",
    "vitest": "^3.0.0"
  },
  "engines": { "node": ">=20" },
  "keywords": ["nestjs", "telescope", "dashboard", "ui", "observability", "react"]
}
```

> After writing, run `pnpm install` from the repo root. If any version doesn't resolve, bump to the nearest resolvable and note it.

- [ ] **Step 2: TS configs.**

`packages/ui/tsconfig.json` (editor/app baseline; extends repo base):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "node"],
    "noEmit": true
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
```

`packages/ui/tsconfig.lib.json` (compiles client + react libs to `dist/`):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "types": ["node"]
  },
  "include": ["src/client", "src/react"]
}
```

`packages/ui/tsconfig.server.json` (compiles the Nest module to `dist/server`):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist/server",
    "rootDir": "src/server",
    "declaration": true,
    "types": ["node", "reflect-metadata"]
  },
  "include": ["src/server"]
}
```

> Note: `tsconfig.lib.json` has `rootDir: src` and includes `src/client` + `src/react`, so outputs land at `dist/client/*` and `dist/react/*` — matching the exports map.

- [ ] **Step 3: Vite + Tailwind + vitest configs.**

`packages/ui/vite.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The SPA is mounted at /telescope and assets are served from /telescope/assets
// by the Nest controller, so the built index.html must reference that base.
export default defineConfig({
  plugins: [react()],
  base: '/telescope/',
  build: {
    outDir: 'dist/spa',
    emptyOutDir: true,
  },
});
```

`packages/ui/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
  },
});
```

`packages/ui/tailwind.config.ts`:
```ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
```

`packages/ui/postcss.config.cjs`:
```cjs
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 4: The trivial app (proves the pipeline).**

`packages/ui/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Telescope</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/app/main.tsx"></script>
  </body>
</html>
```

`packages/ui/src/app/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`packages/ui/src/app/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './index.css';

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
```

`packages/ui/src/app/App.tsx`:
```tsx
import { useEffect, useState } from 'react';

export function App(): JSX.Element {
  const [meta, setMeta] = useState<unknown>(null);
  useEffect(() => {
    fetch('/telescope/api/meta')
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => setMeta({ error: true }));
  }, []);
  return (
    <div className="min-h-screen bg-zinc-950 p-6 font-mono text-sm text-zinc-200">
      <h1 className="text-lg font-semibold text-emerald-400">Telescope</h1>
      <pre className="mt-4 text-zinc-400">{JSON.stringify(meta, null, 2)}</pre>
    </div>
  );
}
```

- [ ] **Step 5: Stub library entrypoints** (filled by later tasks; keep the build green now).

`packages/ui/src/client/index.ts`:
```ts
export {};
```
`packages/ui/src/react/index.ts`:
```ts
export {};
```
`packages/ui/src/server/index.ts`:
```ts
export {};
```

- [ ] **Step 6: Register in changesets `linked`** (`.changeset/config.json`): add `"@dudousxd/nestjs-telescope-ui"` to the `linked` array.

- [ ] **Step 7: Install, build, verify outputs.**
```bash
pnpm install
pnpm --filter @dudousxd/nestjs-telescope-ui build
```
Expected: `packages/ui/dist/spa/index.html` + `dist/spa/assets/*.js` (bundled React app), `dist/client/index.js`, `dist/react/index.js`, `dist/server/index.js` all exist. Verify:
```bash
ls packages/ui/dist/spa packages/ui/dist/spa/assets packages/ui/dist/server packages/ui/dist/client packages/ui/dist/react
```
Then `pnpm --filter @dudousxd/nestjs-telescope-ui test` (passes with no tests) and `pnpm lint`.

- [ ] **Step 8: Commit**
```bash
git add packages/ui .changeset/config.json pnpm-lock.yaml
git commit -m "chore(ui): scaffold @dudousxd/nestjs-telescope-ui (Vite SPA + dual tsc libs)"
```

---

## Task 2: Typed API client (`src/client`)

**Files:** `packages/ui/src/client/types.ts`, `packages/ui/src/client/telescope-client.ts`, `packages/ui/src/client/index.ts`, test `packages/ui/src/client/telescope-client.spec.ts`.

- [ ] **Step 1: Write the failing test** — `telescope-client.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createTelescopeClient } from './telescope-client.js';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('createTelescopeClient', () => {
  it('lists entries with type + cursor query params', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [], nextCursor: null }));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.entries({ type: 'query', cursor: 'abc', limit: 10 });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/telescope/api/entries?');
    expect(url).toContain('type=query');
    expect(url).toContain('cursor=abc');
    expect(url).toContain('limit=10');
  });

  it('fetches a single entry (with its batch)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'x', batch: [] }));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    const entry = await client.entry('x');
    expect((fetchMock.mock.calls[0]![0] as string)).toBe('/telescope/api/entries/x');
    expect(entry).toMatchObject({ id: 'x' });
  });

  it('fetches pulse and queues with a window param', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.pulse('15m');
    await client.queues('1h');
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/pulse?window=15m');
    expect(fetchMock.mock.calls[1]![0] as string).toBe('/telescope/api/queues?window=1h');
  });

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await expect(client.meta()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.**

`packages/ui/src/client/types.ts` — mirror the core response shapes (keep them local/structural; do not import from the server package to keep `/client` framework- and backend-agnostic):
```ts
export interface Entry {
  id: string;
  batchId: string;
  type: string;
  familyHash: string | null;
  content: unknown;
  tags: string[];
  sequence: number;
  durationMs: number | null;
  origin: string;
  instanceId: string;
  createdAt: string;
}
export interface Page<T> { data: T[]; nextCursor: string | null; }
export interface EntryWithBatch extends Entry { batch: Entry[]; }
export interface EntriesQuery { type?: string; tag?: string; batchId?: string; familyHash?: string; cursor?: string; limit?: number; }
export interface TelescopeMeta { enabled: boolean; droppedCount: number; watchers: string[]; }
// Pulse/queues are typed loosely here (full shapes land with those views).
export type PulseReport = Record<string, unknown>;
export type QueueMetricsReport = Record<string, unknown>;
```

`packages/ui/src/client/telescope-client.ts`:
```ts
import type {
  EntriesQuery,
  EntryWithBatch,
  Page,
  PulseReport,
  QueueMetricsReport,
  TelescopeMeta,
  Entry,
} from './types.js';

export interface TelescopeClientOptions {
  /** Base URL of the telescope API. Default '/telescope/api'. */
  baseUrl?: string;
  /** Fetch implementation (injectable for tests). Default global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface TelescopeClient {
  entries(query?: EntriesQuery): Promise<Page<Entry>>;
  entry(id: string): Promise<EntryWithBatch>;
  pulse(window?: string): Promise<PulseReport>;
  queues(window?: string): Promise<QueueMetricsReport>;
  meta(): Promise<TelescopeMeta>;
}

export function createTelescopeClient(options: TelescopeClientOptions = {}): TelescopeClient {
  const baseUrl = (options.baseUrl ?? '/telescope/api').replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;

  async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    let url = `${baseUrl}${path}`;
    if (params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) search.set(key, String(value));
      }
      const qs = search.toString();
      if (qs) url += `?${qs}`;
    }
    const response = await doFetch(url);
    if (!response.ok) throw new Error(`Telescope API ${path} failed: ${response.status}`);
    return (await response.json()) as T;
  }

  return {
    entries: (query = {}) =>
      get<Page<Entry>>('/entries', {
        type: query.type,
        tag: query.tag,
        batchId: query.batchId,
        familyHash: query.familyHash,
        cursor: query.cursor,
        limit: query.limit,
      }),
    entry: (id) => get<EntryWithBatch>(`/entries/${encodeURIComponent(id)}`),
    pulse: (window) => get<PulseReport>('/pulse', { window }),
    queues: (window) => get<QueueMetricsReport>('/queues', { window }),
    meta: () => get<TelescopeMeta>('/meta'),
  };
}
```

`packages/ui/src/client/index.ts`:
```ts
export { createTelescopeClient } from './telescope-client.js';
export type { TelescopeClient, TelescopeClientOptions } from './telescope-client.js';
export type * from './types.js';
```

- [ ] **Step 4: Run tests + typecheck (`pnpm --filter @dudousxd/nestjs-telescope-ui test -- telescope-client` and `... typecheck`), lint.**

- [ ] **Step 5: Commit**
```bash
git add packages/ui/src/client
git commit -m "feat(ui): typed framework-agnostic telescope API client"
```

---

## Task 3: Server module — serve the bundled SPA (`src/server`)

**Files:** `packages/ui/src/server/telescope-ui.controller.ts`, `telescope-ui.module.ts`, `telescope-ui.options.ts`, `index.ts`; test `telescope-ui.controller.spec.ts`. Modify core `packages/core/src/nest/telescope.module.ts` (middleware exclude).

- [ ] **Step 1: Write the failing test** — `telescope-ui.controller.spec.ts` (uses a fixture assets dir, no real SPA build needed):

```ts
import 'reflect-metadata';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelescopeUiModule } from './telescope-ui.module.js';

describe('TelescopeUiController', () => {
  let app: INestApplication;
  const dir = mkdtempSync(join(tmpdir(), 'tele-ui-'));

  beforeAll(async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Telescope</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'assets', 'app.css'), 'body{}');

    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeUiModule.forRoot({ assetsDir: dir })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves index.html at /telescope', async () => {
    const res = await request(app.getHttpServer()).get('/telescope').expect(200);
    expect(res.header['content-type']).toContain('text/html');
    expect(res.text).toContain('Telescope');
  });

  it('serves a js asset with the right content-type', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/assets/app.js').expect(200);
    expect(res.header['content-type']).toContain('javascript');
    expect(res.text).toContain('console.log');
  });

  it('serves a css asset', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/assets/app.css').expect(200);
    expect(res.header['content-type']).toContain('css');
  });

  it('rejects path traversal', async () => {
    await request(app.getHttpServer()).get('/telescope/assets/..%2f..%2fpackage.json').expect(404);
  });

  it('404s an unknown asset', async () => {
    await request(app.getHttpServer()).get('/telescope/assets/missing.js').expect(404);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement the options token + module + controller.**

`packages/ui/src/server/telescope-ui.options.ts`:
```ts
export const TELESCOPE_UI_OPTIONS = Symbol('TELESCOPE_UI_OPTIONS');
export interface TelescopeUiModuleOptions {
  /** Directory of the built SPA (index.html + assets/). Defaults to the bundled dist/spa. */
  assetsDir?: string;
}
```

`packages/ui/src/server/telescope-ui.controller.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller, Get, Header, Inject, NotFoundException, Param } from '@nestjs/common';
import { TELESCOPE_UI_OPTIONS, type TelescopeUiModuleOptions } from './telescope-ui.options.js';

/** dist/server/telescope-ui.controller.js -> ../spa */
const DEFAULT_ASSETS_DIR = fileURLToPath(new URL('../spa', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

@Controller('telescope')
export class TelescopeUiController {
  private readonly assetsDir: string;

  constructor(@Inject(TELESCOPE_UI_OPTIONS) options: TelescopeUiModuleOptions) {
    this.assetsDir = options.assetsDir ?? DEFAULT_ASSETS_DIR;
  }

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  index(): string {
    const indexPath = join(this.assetsDir, 'index.html');
    if (!existsSync(indexPath)) {
      throw new NotFoundException('Telescope UI is not built. Run the package build.');
    }
    return readFileSync(indexPath, 'utf8');
  }

  @Get('assets/:file')
  asset(@Param('file') file: string): { data: Buffer; type: string } {
    // basename strips any path components — defeats traversal (../, nested).
    const safe = basename(file);
    if (safe !== file || safe.includes('\\')) throw new NotFoundException();
    const assetPath = resolve(this.assetsDir, 'assets', safe);
    const root = resolve(this.assetsDir, 'assets');
    if (!assetPath.startsWith(root + require('node:path').sep) || !existsSync(assetPath)) {
      throw new NotFoundException();
    }
    const type = CONTENT_TYPES[extname(safe)] ?? 'application/octet-stream';
    return { data: readFileSync(assetPath), type };
  }
}
```

> The `@Get('assets/:file')` handler returns a Buffer; set its content-type with an interceptor-free approach: since `@Header` is static, instead stream via the response would couple to Express. To stay platform-agnostic AND set a dynamic content-type, use a small `@Res({ passthrough: true })`-free approach: return the Buffer and set the header via a per-route reflection. SIMPLER + platform-agnostic: split into per-extension handlers is overkill. Use `@Res({ passthrough: true })` is express-coupled. **Chosen approach:** keep the dynamic content-type by reading it in the handler and using Nest's `@Header` won't work (static). So implement `asset` to use a `StreamableFile`? That is platform-agnostic in Nest 11. Replace the asset handler return with a `StreamableFile` carrying the type:
>
> ```ts
> import { StreamableFile } from '@nestjs/common';
> // ...
> @Get('assets/:file')
> asset(@Param('file') file: string): StreamableFile {
>   const safe = basename(file);
>   if (safe !== file) throw new NotFoundException();
>   const root = resolve(this.assetsDir, 'assets');
>   const assetPath = resolve(root, safe);
>   if (!assetPath.startsWith(`${root}/`) || !existsSync(assetPath)) throw new NotFoundException();
>   const type = CONTENT_TYPES[extname(safe)] ?? 'application/octet-stream';
>   return new StreamableFile(readFileSync(assetPath), { type });
> }
> ```
> `StreamableFile` works on both Express and Fastify in NestJS 11 and sets `Content-Type` from `{ type }`. Use THIS version (delete the `{ data, type }` object version and the `require('node:path')` line). Keep `index()` returning a string with the static `@Header` (html is always text/html).

`packages/ui/src/server/telescope-ui.module.ts`:
```ts
import { type DynamicModule, Module } from '@nestjs/common';
import { TelescopeUiController } from './telescope-ui.controller.js';
import { TELESCOPE_UI_OPTIONS, type TelescopeUiModuleOptions } from './telescope-ui.options.js';

@Module({})
export class TelescopeUiModule {
  static forRoot(options: TelescopeUiModuleOptions = {}): DynamicModule {
    return {
      module: TelescopeUiModule,
      controllers: [TelescopeUiController],
      providers: [{ provide: TELESCOPE_UI_OPTIONS, useValue: options }],
    };
  }
}
```

`packages/ui/src/server/index.ts`:
```ts
export { TelescopeUiModule } from './telescope-ui.module.js';
export type { TelescopeUiModuleOptions } from './telescope-ui.options.js';
```

- [ ] **Step 4: Core middleware exclude.** In `packages/core/src/nest/telescope.module.ts` `configure()`, change the exclude so the dashboard's own loads aren't recorded: replace `.exclude({ path: 'telescope/api/{*splat}', method: RequestMethod.ALL })` with `.exclude({ path: 'telescope/{*splat}', method: RequestMethod.ALL }, { path: 'telescope', method: RequestMethod.ALL })`. (Covers `/telescope`, `/telescope/api/*`, and `/telescope/assets/*`.) Run the core suite to confirm no regression.

- [ ] **Step 5: Run tests + typecheck + lint.**
- `pnpm --filter @dudousxd/nestjs-telescope-ui test -- telescope-ui.controller` → 5 pass
- `pnpm --filter @dudousxd/nestjs-telescope test` → core green (middleware change)
- `pnpm --filter @dudousxd/nestjs-telescope-ui typecheck`, `pnpm lint`

- [ ] **Step 6: Commit**
```bash
git add packages/ui/src/server packages/core/src/nest/telescope.module.ts
git commit -m "feat(ui): TelescopeUiModule serves the bundled SPA (platform-agnostic, path-safe)"
```

---

## Task 4: React layer — hooks + Entries components (`src/react`)

**Files:** `packages/ui/src/react/telescope-context.tsx` (provider exposing the client), `use-telescope-queries.ts` (hooks), `components/type-tabs.tsx`, `components/entries-table.tsx`, `components/batch-timeline.tsx`, `components/entry-detail.tsx`, `index.ts`; smoke tests `components/entries-table.spec.tsx`.

- [ ] **Step 1: Provider + hooks.**

`telescope-context.tsx`:
```tsx
import { createContext, useContext } from 'react';
import { createTelescopeClient, type TelescopeClient } from '../client/index.js';

const TelescopeContext = createContext<TelescopeClient | null>(null);

export function TelescopeProvider({ client, children }: { client?: TelescopeClient; children: React.ReactNode }): JSX.Element {
  const value = client ?? createTelescopeClient();
  return <TelescopeContext.Provider value={value}>{children}</TelescopeContext.Provider>;
}

export function useTelescopeClient(): TelescopeClient {
  const client = useContext(TelescopeContext);
  if (!client) throw new Error('useTelescopeClient must be used within a TelescopeProvider');
  return client;
}
```

`use-telescope-queries.ts` (options-returning + use wrappers, per Davi's convention):
```ts
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { EntriesQuery } from '../client/index.js';
import type { TelescopeClient } from '../client/index.js';

const REFETCH_MS = 3000;

export function entriesQuery(client: TelescopeClient, query: EntriesQuery = {}) {
  return queryOptions({
    queryKey: ['telescope', 'entries', query],
    queryFn: () => client.entries(query),
    refetchInterval: REFETCH_MS,
  });
}
export function entryQuery(client: TelescopeClient, id: string) {
  return queryOptions({ queryKey: ['telescope', 'entry', id], queryFn: () => client.entry(id) });
}
export function pulseQuery(client: TelescopeClient, window: string) {
  return queryOptions({ queryKey: ['telescope', 'pulse', window], queryFn: () => client.pulse(window), refetchInterval: REFETCH_MS });
}
export function queuesQuery(client: TelescopeClient, window: string) {
  return queryOptions({ queryKey: ['telescope', 'queues', window], queryFn: () => client.queues(window), refetchInterval: REFETCH_MS });
}
```
Plus `use*` wrappers that read the client from context:
```ts
import { useTelescopeClient } from './telescope-context.js';
export function useEntries(query: EntriesQuery = {}) { return useQuery(entriesQuery(useTelescopeClient(), query)); }
export function useEntry(id: string) { return useQuery(entryQuery(useTelescopeClient(), id)); }
export function usePulse(window: string) { return useQuery(pulseQuery(useTelescopeClient(), window)); }
export function useQueues(window: string) { return useQuery(queuesQuery(useTelescopeClient(), window)); }
```
(Place the `use*` wrappers in the same file or a `use-telescope-queries.ts`; keep imports tidy.)

- [ ] **Step 2: Components.** Presentational, dark Tailwind, accept data as props (so they're testable + composable). Provide an `entryLabel(entry)` helper (mirror the pulse `labelFor`: uri/method, sql, queue:name, else type).

`components/type-tabs.tsx`:
```tsx
const TYPES = ['all', 'request', 'query', 'job', 'exception', 'http_client', 'mail'] as const;
export function TypeTabs({ active, onChange }: { active: string; onChange: (t: string) => void }): JSX.Element {
  return (
    <div className="flex gap-1 border-b border-zinc-800">
      {TYPES.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          className={`px-3 py-2 text-xs uppercase tracking-wide ${active === t ? 'border-b-2 border-emerald-400 text-emerald-300' : 'text-zinc-500 hover:text-zinc-300'}`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
```

`components/entries-table.tsx`:
```tsx
import type { Entry } from '../client/index.js';

export function entryLabel(entry: Entry): string {
  const c = entry.content;
  if (typeof c === 'object' && c !== null) {
    const r = c as Record<string, unknown>;
    if (typeof r.uri === 'string') return typeof r.method === 'string' ? `${r.method} ${r.uri}` : r.uri;
    if (typeof r.sql === 'string') return r.sql;
    if (typeof r.queue === 'string' && typeof r.name === 'string') return `${r.queue}:${r.name}`;
    if (typeof r.message === 'string') return r.message;
    if (typeof r.url === 'string') return `${typeof r.method === 'string' ? r.method : ''} ${r.url}`.trim();
  }
  return entry.type;
}

export function EntriesTable({ entries, onSelect }: { entries: Entry[]; onSelect?: (id: string) => void }): JSX.Element {
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-zinc-500">
        <tr><th className="py-2">Time</th><th>Type</th><th>Summary</th><th>Duration</th><th>Tags</th></tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr
            key={e.id}
            onClick={() => onSelect?.(e.id)}
            className="cursor-pointer border-t border-zinc-900 hover:bg-zinc-900"
          >
            <td className="py-1.5 text-zinc-500">{new Date(e.createdAt).toLocaleTimeString()}</td>
            <td className="text-emerald-400">{e.type}</td>
            <td className="max-w-md truncate text-zinc-300">{entryLabel(e)}</td>
            <td className="text-zinc-400">{e.durationMs != null ? `${e.durationMs}ms` : '—'}</td>
            <td className="text-zinc-600">{e.tags.join(' ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

`components/batch-timeline.tsx` and `components/entry-detail.tsx`:
```tsx
// batch-timeline.tsx
import type { Entry } from '../client/index.js';
import { entryLabel } from './entries-table.js';
export function BatchTimeline({ batch, currentId, onSelect }: { batch: Entry[]; currentId: string; onSelect?: (id: string) => void }): JSX.Element {
  return (
    <ol className="space-y-1">
      {[...batch].sort((a, b) => a.sequence - b.sequence).map((e) => (
        <li key={e.id}>
          <button type="button" onClick={() => onSelect?.(e.id)}
            className={`flex w-full justify-between gap-4 px-2 py-1 text-left text-xs ${e.id === currentId ? 'bg-zinc-800 text-emerald-300' : 'text-zinc-400 hover:bg-zinc-900'}`}>
            <span><span className="text-emerald-500">{e.type}</span> {entryLabel(e)}</span>
            <span className="text-zinc-600">{e.durationMs != null ? `${e.durationMs}ms` : ''}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
```
```tsx
// entry-detail.tsx
import type { EntryWithBatch } from '../client/index.js';
import { BatchTimeline } from './batch-timeline.js';
export function EntryDetail({ entry, onSelect }: { entry: EntryWithBatch; onSelect?: (id: string) => void }): JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-6">
      <section className="col-span-2">
        <h2 className="mb-2 text-sm text-emerald-400">{entry.type}</h2>
        <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">{JSON.stringify(entry.content, null, 2)}</pre>
      </section>
      <aside>
        <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Batch ({entry.batch.length})</h3>
        <BatchTimeline batch={entry.batch} currentId={entry.id} onSelect={onSelect} />
      </aside>
    </div>
  );
}
```

`index.ts` exports the provider, hooks, and all components, and re-exports the client:
```ts
export * from './telescope-context.js';
export * from './use-telescope-queries.js';
export * from './components/type-tabs.js';
export * from './components/entries-table.js';
export * from './components/batch-timeline.js';
export * from './components/entry-detail.js';
export * from '../client/index.js';
```

- [ ] **Step 3: Smoke test** — `components/entries-table.spec.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../../client/index.js';
import { EntriesTable, entryLabel } from './entries-table.js';

const entry = (over: Partial<Entry> & { type: string }): Entry => ({
  id: 'e1', batchId: 'b', familyHash: null, content: {}, tags: [], sequence: 0,
  durationMs: 12, origin: 'http', instanceId: 'i', createdAt: '2026-06-02T12:00:00Z', ...over,
});

describe('EntriesTable', () => {
  it('derives a label by type', () => {
    expect(entryLabel(entry({ type: 'query', content: { sql: 'select 1' } }))).toBe('select 1');
    expect(entryLabel(entry({ type: 'request', content: { method: 'GET', uri: '/a' } }))).toBe('GET /a');
  });
  it('renders rows with type + summary', () => {
    render(<EntriesTable entries={[entry({ type: 'query', content: { sql: 'select 1' } })]} />);
    expect(screen.getByText('query')).toBeTruthy();
    expect(screen.getByText('select 1')).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run tests (`pnpm --filter @dudousxd/nestjs-telescope-ui test`), typecheck, lint.**

- [ ] **Step 5: Commit**
```bash
git add packages/ui/src/react
git commit -m "feat(ui): react hooks + Entries components (composable, exported at /react)"
```

---

## Task 5: Wire the bundled app — Entries + detail pages

**Files:** rewrite `packages/ui/src/app/App.tsx`; add `src/app/pages/entries-page.tsx`, `src/app/pages/entry-page.tsx`, `src/app/dashboard-layout.tsx`. Uses react-router (hash) + the `/react` layer.

- [ ] **Step 1: Layout + router.** `dashboard-layout.tsx` renders the dark shell + nav (Entries / Pulse / Queues links — Pulse/Queues route to placeholders for now). `App.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { TelescopeProvider } from '../react/index.js';
import { DashboardLayout } from './dashboard-layout.js';
import { EntriesPage } from './pages/entries-page.js';
import { EntryPage } from './pages/entry-page.js';

const queryClient = new QueryClient();

export function App(): JSX.Element {
  return (
    <TelescopeProvider>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <DashboardLayout>
            <Routes>
              <Route path="/" element={<Navigate to="/entries" replace />} />
              <Route path="/entries" element={<EntriesPage />} />
              <Route path="/entries/:id" element={<EntryPage />} />
              <Route path="/pulse" element={<div className="p-6 text-zinc-500">Pulse — coming next.</div>} />
              <Route path="/queues" element={<div className="p-6 text-zinc-500">Queues — coming next.</div>} />
            </Routes>
          </DashboardLayout>
        </HashRouter>
      </QueryClientProvider>
    </TelescopeProvider>
  );
}
```

- [ ] **Step 2: Entries page** — `pages/entries-page.tsx`: `useState` for the active type tab; `useEntries({ type: active === 'all' ? undefined : active })`; render `<TypeTabs>` + `<EntriesTable entries={data?.data ?? []} onSelect={(id) => navigate('/entries/' + id)}>`; a small "paused/live" indicator. Use `useNavigate` from react-router.

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EntriesTable, TypeTabs, useEntries } from '../../react/index.js';

export function EntriesPage(): JSX.Element {
  const [type, setType] = useState('all');
  const navigate = useNavigate();
  const { data, isLoading } = useEntries(type === 'all' ? {} : { type });
  return (
    <div>
      <TypeTabs active={type} onChange={setType} />
      <div className="p-4">
        {isLoading ? <p className="text-zinc-600">Loading…</p> : (
          <EntriesTable entries={data?.data ?? []} onSelect={(id) => navigate(`/entries/${id}`)} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Entry page** — `pages/entry-page.tsx`: `useParams` id; `useEntry(id)`; render `<EntryDetail entry={data} onSelect={navigate}>` + a back link.
```tsx
import { useNavigate, useParams } from 'react-router-dom';
import { EntryDetail, useEntry } from '../../react/index.js';

export function EntryPage(): JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, isLoading } = useEntry(id);
  return (
    <div className="p-4">
      <button type="button" onClick={() => navigate('/entries')} className="mb-4 text-xs text-zinc-500 hover:text-zinc-300">← entries</button>
      {isLoading || !data ? <p className="text-zinc-600">Loading…</p> : <EntryDetail entry={data} onSelect={(eid) => navigate(`/entries/${eid}`)} />}
    </div>
  );
}
```

- [ ] **Step 4: `dashboard-layout.tsx`** — dark shell + nav using react-router `NavLink` (Entries/Pulse/Queues) and a title. Keep it simple and dark.

- [ ] **Step 5: Build + verify the bundle still builds and includes the app.**
```bash
pnpm --filter @dudousxd/nestjs-telescope-ui build
```
Confirm `dist/spa/index.html` + `dist/spa/assets/*.js` exist and the build succeeds (the app compiles with router + react-query + hooks). Run `pnpm --filter @dudousxd/nestjs-telescope-ui typecheck` and `pnpm lint`.

> Note: no DOM e2e here (would need a headless browser). The controller test (Task 3) proves serving; the client/react tests prove data + rendering; this task proves the app compiles/bundles. A real browser smoke check is a manual follow-up.

- [ ] **Step 6: Commit**
```bash
git add packages/ui/src/app packages/ui/index.html
git commit -m "feat(ui): wire bundled dashboard — Entries list + correlated detail"
```

---

## Task 6: Docs + packages table + changeset + whole-repo verify

- [ ] **Step 1: `packages/ui/README.md`** — install, the turnkey usage (`imports: [TelescopeUiModule.forRoot()]`, dashboard at `/telescope`), and the composable usage (`import { EntriesTable, useEntries, TelescopeProvider } from '@dudousxd/nestjs-telescope-ui/react'`). Note React/Tailwind are bundled (host needs nothing frontend).

- [ ] **Step 2: Root `README.md`** — add the `@dudousxd/nestjs-telescope-ui` row (✅ shipped — "Bundled dashboard SPA + composable React components/hooks/client") and a one-liner that the dashboard mounts at `/telescope`.

- [ ] **Step 3: Changeset** `.changeset/telescope-ui.md`:
```markdown
---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Add `@dudousxd/nestjs-telescope-ui`: a bundled React dashboard served by
`TelescopeUiModule` (no host frontend deps), with an Entries view (type tabs,
polling) and correlated entry detail. The same building blocks are exported at
`/react` (components + hooks) and `/client` (typed API client) so consumers can
compose their own dashboard. Core's request middleware now also excludes the
`/telescope` UI routes from capture.
```

- [ ] **Step 4: Whole-repo `pnpm build && pnpm test && pnpm lint`** — all green. Report numbers.

- [ ] **Step 5: Commit**
```bash
git add README.md packages/ui/README.md .changeset/telescope-ui.md
git commit -m "docs: document @dudousxd/nestjs-telescope-ui and add changeset"
```

---

## Self-Review

**Spec coverage (this plan = foundation + Entries slice of the UI spec):** bundled SPA + Nest serving (Tasks 1, 3), composable layers exported at `.`/`/react`/`/client` (Tasks 2, 4, server 3), Entries list + tabs + polling + correlated detail (Tasks 4, 5), dark console (Tasks 4, 5), docs (Task 6). Pulse + Queues VIEWS are a deliberate follow-up plan (the client already has `pulse()`/`queues()`; routes are placeholders).

**Placeholder scan:** The Pulse/Queues routes render "coming next" placeholders — intentional and called out, not a missing requirement (those views are the next plan). All code steps contain complete code. The `asset` handler has TWO versions in Task 3 Step 3 — the prose mandates the `StreamableFile` version; the implementer MUST use that and delete the `{ data, type }`/`require` version.

**Type consistency:** `createTelescopeClient` returns `TelescopeClient` ({entries,entry,pulse,queues,meta}); `src/client/types.ts` defines `Entry`/`Page`/`EntryWithBatch`/`EntriesQuery` used by the client, the hooks (`entriesQuery`/`useEntries` etc.), and the components (`EntriesTable`/`EntryDetail`/`BatchTimeline`). The hooks return TanStack `queryOptions` (Davi's options-returning convention) with `use*` wrappers. `entryLabel` is defined once in `entries-table.tsx` and reused by `batch-timeline.tsx`. Exports map (`.`=server, `/react`, `/client`) matches the tsconfig outputs (`dist/server`, `dist/react`, `dist/client`) and the Vite bundle (`dist/spa`).

**Risk note:** Task 1 (triple build) and Task 3 (`import.meta.url`→`../spa` + `StreamableFile` platform-agnostic serving) are the load-bearing infra; the controller's `assetsDir` override + fixture tests verify serving independently of the Vite build, and Task 1's trivial app proves the bundle pipeline before any views are added.
