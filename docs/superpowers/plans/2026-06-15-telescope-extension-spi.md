# Telescope Extension SPI + declarative dashboard panels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `TelescopeExtension` SPI to `nestjs-telescope` that lets external libs contribute navigable entry types, declarative dashboard panels, and server-side data providers — with `nestjs-durable` shipping a native "Workflows" health/metrics dashboard as the first consumer.

**Architecture:** Mirror the proven `@dudousxd/nestjs-codegen` extension model: a versioned contract + a registry that merges multi-hooks and enforces collision errors. Extensions emit a neutral **panel IR** (data, no React); a generic renderer in `nestjs-telescope-ui` interprets it using existing chart components. Data is fetched per-panel through a gated `GET /api/ext/:ext/data/:provider` route. The existing `Watcher` SPI is unchanged and becomes one hook of an extension.

**Tech Stack:** TypeScript, NestJS 10/11, vitest (+ supertest for controllers, @testing-library/react for UI), recharts, Fumadocs (docs). pnpm monorepo.

**Spec:** `docs/superpowers/specs/2026-06-15-telescope-extension-spi-design.md`

**Repos touched:**
- `nestjs-telescope` — `packages/core` (SPI, registry, wiring, meta, data route), `packages/ui` (renderer, page, nav), docs.
- `nestjs-durable` — `packages/telescope` (the first consumer extension), docs.

**Data sources (per spec):** **A** — captured `durable` entries via the exported `TELESCOPE_STORAGE` (success rate, throughput, top failures); **C** — the durable `STATE_STORE` via `listRuns` (current-state gauges: dead/running/suspended/pending now). Both resolved with `ctx.moduleRef`.

**Conventions discovered (use these, do not invent):**
- Run a single core test: `pnpm -C packages/core test -- <file>.spec.ts`
- Run a single UI test: `pnpm -C packages/ui test -- <file>.spec.tsx`
- Run durable telescope tests: `pnpm -C packages/telescope test` (from `nestjs-durable`)
- Controller tests use `Test.createTestingModule({ imports: [TelescopeModule.forRoot(opts)] })` + `supertest`. Always `await app.close()` in `afterEach`.
- UI chart tests must `vi.mock('recharts', …)` to stub `ResponsiveContainer` (jsdom renders 0×0).
- Collisions throw at boot, naming both owners (mirror codegen's `mergeExclusive`).

---

## File structure

**`nestjs-telescope/packages/core`**
- Create `src/extension/types.ts` — the published contract: `TelescopeExtension`, `ExtensionContext`, `DashboardSpec`, `Panel`, `DataBinding`, `Column`, `LinkSpec`, `DataProvider`, `defineTelescopeExtension`.
- Create `src/extension/registry.ts` — `ExtensionRegistry` resolving extensions → merged watchers / entry types / dashboards / providers, with collision errors.
- Create `src/extension/index.ts` — barrel re-export.
- Modify `src/nest/telescope.options.ts` — add `extensions?: TelescopeExtension[]` to `TelescopeModuleOptions`; add `TELESCOPE_EXTENSIONS` token.
- Modify `src/nest/telescope.module.ts` — provide `TELESCOPE_EXTENSIONS` (build + boot-validate registry), export it.
- Modify `src/nest/telescope-watcher-registrar.service.ts` — merge `registry.watchers()` into registered watchers; include extension entry-type ids in `setWatchers`.
- Modify `src/nest/telescope.service.ts` — extend `TelescopeMeta` with `entryTypes` + `dashboards`; return them from `getMeta()`; resolve dashboards via the registry + an `ExtensionContext`.
- Create `src/nest/extension-context.factory.ts` — builds the `ExtensionContext` (`{ moduleRef, config }`) handed to providers/dashboards.
- Modify `src/nest/telescope.controller.ts` — add `GET ext/:ext/data/:provider`.
- Modify `src/index.ts` — export the extension barrel + `TELESCOPE_STORAGE` is already exported (confirm).

**`nestjs-telescope/packages/ui`**
- Create `src/react/components/extensions/panel-renderer.tsx` — `PanelRenderer` switching on `panel.kind`.
- Create `src/react/components/extensions/stat-card.tsx` — extracted shared `StatCard` (currently private in `OverviewPage`).
- Modify `src/react/components/entry-types.ts` — `visibleEntryTypes` also accepts extension-contributed types from meta.
- Create `src/app/pages/extension-dashboard-page.tsx` — loads a `DashboardSpec` from meta + renders panels, each binding data through a new hook.
- Create `src/app/hooks/use-extension-data.ts` — fetch `/api/ext/:ext/data/:provider`.
- Modify `src/app/App.tsx` — add route `/ext/:dashboardId`.
- Modify `src/app/dashboard-layout.tsx` — render extension dashboards + entry types in nav from meta.
- Modify the UI client (`src/app/.../client`) — add `meta` already exists; add `extData(ext, provider, query)`.

**`nestjs-durable/packages/telescope`**
- Create `src/durable-data-providers.ts` — `durable.state` (store gauges) + `durable.timeseries` (captured entries).
- Create `src/durable-dashboard.spec-data.ts` — the `DashboardSpec` factory for the Workflows page.
- Create `src/durable-telescope.extension.ts` — `durableTelescopeExtension()` bundling watcher + entryType + dashboard + providers.
- Modify `src/index.ts` — export the extension (keep exporting the watcher for back-compat).
- Modify `package.json` — no new runtime deps (uses exported tokens/types only).

**Docs**
- `nestjs-telescope/website/content/docs/concepts/extensions.mdx` (new), `recipes/building-an-extension.mdx` (new), `reference/configuration.mdx` (update), `packages/index.mdx` (update), relevant `meta.json` (update).
- `nestjs-durable/website/content/docs/observability/telescope.mdx` (update).

---

## Phase 1 — Core SPI contract + registry

### Task 1: The extension contract types

**Files:**
- Create: `packages/core/src/extension/types.ts`
- Create: `packages/core/src/extension/index.ts`

- [ ] **Step 1: Write `types.ts`**

```ts
// packages/core/src/extension/types.ts
import type { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import type { Watcher } from '../nest/watcher.js';

/**
 * The published, versioned extension contract for `@dudousxd/nestjs-telescope`.
 *
 * Extensions are objects (usually returned by a factory so they can take options)
 * registered via `TelescopeModule.forRoot({ extensions: [...] })`. The host runs
 * their hooks at module init. Hooks are **multi** (every extension runs; results
 * accumulate). Single-slot hooks are intentionally not part of 0.x — the registry
 * is shaped to add them when a consumer needs one.
 *
 * @remarks Semver 0.x — the shape may change until 1.0. Out-of-repo extensions
 * should pin a compatible `@dudousxd/nestjs-telescope` peer range.
 */
export interface TelescopeExtension {
  /** Unique id — used in conflict/collision errors and for deterministic ordering. */
  name: string;
  /** Contribute watchers. Merged into the existing `forRoot.watchers` list. */
  watchers?(ctx: ExtensionContext): Watcher[];
  /** Contribute navigable entry types — makes the hard-coded UI ENTRY_TYPES dynamic. */
  entryTypes?(ctx: ExtensionContext): ExtensionEntryType[];
  /** Contribute declarative dashboard pages (the panel IR). */
  dashboards?(ctx: ExtensionContext): DashboardSpec[];
  /** Named server-side queries that panels bind to via `{ provider, query }`. */
  dataProviders?(ctx: ExtensionContext): DataProvider[];
}

/** Read-only context handed to every extension hook, resolved at module init. */
export interface ExtensionContext {
  /** Resolve host services (e.g. a durable engine/store, or TELESCOPE_STORAGE). */
  readonly moduleRef: ModuleRef;
  readonly config: ResolvedCoreConfig;
}

/** A navigable entry type contributed by an extension (subset of the UI's EntryTypeDef). */
export interface ExtensionEntryType {
  /** Backend `type` filter value, e.g. 'durable'. */
  id: string;
  /** Nav label, e.g. 'Workflows'. */
  label: string;
  /** Tailwind `bg-*` dot color for the nav, e.g. 'bg-amber-400'. */
  dot: string;
}

/** A declarative dashboard page. */
export interface DashboardSpec {
  /** Stable route id, e.g. 'durable.workflows'. Globally unique across extensions. */
  id: string;
  /** Nav label, e.g. 'Workflows'. */
  label: string;
  /** Optional nav grouping header. */
  navGroup?: string;
  panels: Panel[];
}

/** A bind from a panel to a named server-side provider + an opaque query object. */
export interface DataBinding {
  /** Provider name, e.g. 'durable.timeseries'. Resolved on the server. */
  provider: string;
  /** Opaque query passed through to the provider's `resolve`. */
  query?: Record<string, unknown>;
}

/** A deep-link out of a table cell (to the durable dashboard, a telescope trace, etc.). */
export interface LinkSpec {
  /** A URL template with `{key}` placeholders filled from the row, e.g. '/durable/runs/{runId}'. */
  href: string;
  /** When true, open in a new tab. */
  external?: boolean;
}

export interface Column {
  key: string;
  label: string;
  link?: LinkSpec;
}

export type Panel =
  | { kind: 'stat'; title: string; data: DataBinding; format?: 'number' | 'percent' | 'duration'; accent?: string }
  | { kind: 'timeseries'; title: string; data: DataBinding; series: string[]; style?: 'area' | 'stacked' }
  | { kind: 'topN'; title: string; data: DataBinding; limit?: number }
  | { kind: 'table'; title: string; data: DataBinding; columns: Column[] };

/** A named server-side query a panel binds to. */
export interface DataProvider {
  /** Stable name referenced by a panel's `DataBinding.provider`, e.g. 'durable.timeseries'. */
  name: string;
  /**
   * Resolve a panel's data. `query` is the panel's `DataBinding.query`. Return value
   * shape is per panel kind:
   *  - stat       → `{ value: number; delta?: number }`
   *  - timeseries → `{ rows: Array<{ label: string } & Record<string, number>> }`
   *  - topN       → `{ items: Array<{ label: string; value: number; id?: string }> }`
   *  - table      → `{ rows: Array<Record<string, unknown>> }`
   */
  resolve(query: Record<string, unknown> | undefined, ctx: ExtensionContext): Promise<unknown>;
}

/** Identity helper for authoring extensions with full type inference. */
export function defineTelescopeExtension(ext: TelescopeExtension): TelescopeExtension {
  return ext;
}
```

- [ ] **Step 2: Write the barrel**

```ts
// packages/core/src/extension/index.ts
export * from './types.js';
export * from './registry.js';
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm -C packages/core exec tsc --noEmit`
Expected: PASS (note: `registry.js` does not exist yet — comment out that export line until Task 2, or do Step 2 after Task 2; if it errors only on the missing `./registry.js`, that is expected and resolved in Task 2).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/extension/types.ts packages/core/src/extension/index.ts
git commit -m "feat(core): add TelescopeExtension contract + panel IR types"
```

---

### Task 2: The extension registry

**Files:**
- Create: `packages/core/src/extension/registry.ts`
- Test: `packages/core/src/extension/registry.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/extension/registry.spec.ts
import { describe, expect, it } from 'vitest';
import type { ExtensionContext, TelescopeExtension } from './types.js';
import { ExtensionRegistry } from './registry.js';

const ctx = { moduleRef: {} as ExtensionContext['moduleRef'], config: {} as ExtensionContext['config'] };

function ext(over: Partial<TelescopeExtension> & { name: string }): TelescopeExtension {
  return over;
}

describe('ExtensionRegistry', () => {
  it('merges watchers from all extensions in registration order', () => {
    const w1 = { type: 'a', register() {} };
    const w2 = { type: 'b', register() {} };
    const reg = new ExtensionRegistry(
      [ext({ name: 'one', watchers: () => [w1] }), ext({ name: 'two', watchers: () => [w2] })],
      ctx,
    );
    expect(reg.watchers().map((w) => w.type)).toEqual(['a', 'b']);
  });

  it('collects entry types and rejects duplicate ids across extensions', () => {
    const reg = () =>
      new ExtensionRegistry(
        [
          ext({ name: 'one', entryTypes: () => [{ id: 'dup', label: 'A', dot: 'bg-a' }] }),
          ext({ name: 'two', entryTypes: () => [{ id: 'dup', label: 'B', dot: 'bg-b' }] }),
        ],
        ctx,
      );
    expect(reg).toThrow(/entry type "dup".*"one".*"two"/);
  });

  it('rejects duplicate dashboard ids and duplicate provider names', () => {
    expect(
      () =>
        new ExtensionRegistry(
          [
            ext({ name: 'one', dashboards: () => [{ id: 'd', label: 'D', panels: [] }] }),
            ext({ name: 'two', dashboards: () => [{ id: 'd', label: 'D2', panels: [] }] }),
          ],
          ctx,
        ),
    ).toThrow(/dashboard "d".*"one".*"two"/);
    expect(
      () =>
        new ExtensionRegistry(
          [
            ext({ name: 'one', dataProviders: () => [{ name: 'p', resolve: async () => null }] }),
            ext({ name: 'two', dataProviders: () => [{ name: 'p', resolve: async () => null }] }),
          ],
          ctx,
        ),
    ).toThrow(/provider "p".*"one".*"two"/);
  });

  it('looks up a provider by name and exposes dashboards + entry types', () => {
    const reg = new ExtensionRegistry(
      [
        ext({
          name: 'one',
          entryTypes: () => [{ id: 'x', label: 'X', dot: 'bg-x' }],
          dashboards: () => [{ id: 'd', label: 'D', panels: [] }],
          dataProviders: () => [{ name: 'p', resolve: async () => ({ value: 1 }) }],
        }),
      ],
      ctx,
    );
    expect(reg.entryTypes()).toEqual([{ id: 'x', label: 'X', dot: 'bg-x' }]);
    expect(reg.dashboards().map((d) => d.id)).toEqual(['d']);
    expect(reg.findProvider('p')).toBeDefined();
    expect(reg.findProvider('missing')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C packages/core test -- registry.spec.ts`
Expected: FAIL — `ExtensionRegistry` is not defined.

- [ ] **Step 3: Implement the registry**

```ts
// packages/core/src/extension/registry.ts
import type { Watcher } from '../nest/watcher.js';
import type {
  DashboardSpec,
  DataProvider,
  ExtensionContext,
  ExtensionEntryType,
  TelescopeExtension,
} from './types.js';

/**
 * Resolves the registered extensions once at module init. Each multi-hook runs for
 * every extension and the results accumulate; an id/name claimed twice is a hard
 * error naming both owners (mirrors nestjs-codegen's `mergeExclusive`). Resolution is
 * eager so collisions fail at boot, not on first request.
 */
export class ExtensionRegistry {
  private readonly _watchers: Watcher[] = [];
  private readonly _entryTypes: ExtensionEntryType[] = [];
  private readonly _dashboards: DashboardSpec[] = [];
  private readonly _providers = new Map<string, DataProvider>();

  constructor(extensions: readonly TelescopeExtension[], ctx: ExtensionContext) {
    const entryOwners = new Map<string, string>();
    const dashOwners = new Map<string, string>();
    const provOwners = new Map<string, string>();

    for (const ext of extensions) {
      for (const w of ext.watchers?.(ctx) ?? []) this._watchers.push(w);

      for (const et of ext.entryTypes?.(ctx) ?? []) {
        const prev = entryOwners.get(et.id);
        if (prev !== undefined) {
          throw new Error(
            `Telescope entry type "${et.id}" is contributed by both "${prev}" and "${ext.name}". Entry-type ids must be unique.`,
          );
        }
        entryOwners.set(et.id, ext.name);
        this._entryTypes.push(et);
      }

      for (const d of ext.dashboards?.(ctx) ?? []) {
        const prev = dashOwners.get(d.id);
        if (prev !== undefined) {
          throw new Error(
            `Telescope dashboard "${d.id}" is contributed by both "${prev}" and "${ext.name}". Dashboard ids must be unique.`,
          );
        }
        dashOwners.set(d.id, ext.name);
        this._dashboards.push(d);
      }

      for (const p of ext.dataProviders?.(ctx) ?? []) {
        const prev = provOwners.get(p.name);
        if (prev !== undefined) {
          throw new Error(
            `Telescope data provider "${p.name}" is contributed by both "${prev}" and "${ext.name}". Provider names must be unique.`,
          );
        }
        provOwners.set(p.name, ext.name);
        this._providers.set(p.name, p);
      }
    }
  }

  watchers(): Watcher[] {
    return [...this._watchers];
  }
  entryTypes(): ExtensionEntryType[] {
    return [...this._entryTypes];
  }
  dashboards(): DashboardSpec[] {
    return [...this._dashboards];
  }
  findProvider(name: string): DataProvider | undefined {
    return this._providers.get(name);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -C packages/core test -- registry.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/extension/registry.ts packages/core/src/extension/registry.spec.ts
git commit -m "feat(core): add ExtensionRegistry with collision-checked multi-hooks"
```

---

### Task 3: Wire `extensions` into module options + provider

**Files:**
- Modify: `packages/core/src/nest/telescope.options.ts`
- Create: `packages/core/src/nest/extension-context.factory.ts`
- Modify: `packages/core/src/nest/telescope.module.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add the option + token**

In `packages/core/src/nest/telescope.options.ts`, add the import and field, and a new token:

```ts
import type { TelescopeExtension } from '../extension/types.js';
```

Inside `TelescopeModuleOptions`, next to `watchers?: Watcher[];`:

```ts
  /** Extensions contributing watchers, entry types, dashboards, and data providers. */
  extensions?: TelescopeExtension[];
```

At the bottom with the other symbols:

```ts
/** Resolved ExtensionRegistry (built + boot-validated from options.extensions). */
export const TELESCOPE_EXTENSIONS = Symbol('TELESCOPE_EXTENSIONS');
```

- [ ] **Step 2: Write the ExtensionContext factory**

```ts
// packages/core/src/nest/extension-context.factory.ts
import type { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import type { ExtensionContext } from '../extension/types.js';

/** Build the read-only context handed to extension hooks/providers. */
export function createExtensionContext(
  moduleRef: ModuleRef,
  config: ResolvedCoreConfig,
): ExtensionContext {
  return { moduleRef, config };
}
```

- [ ] **Step 3: Provide the registry in the module**

In `packages/core/src/nest/telescope.module.ts`, add imports:

```ts
import { ExtensionRegistry } from '../extension/registry.js';
import { createExtensionContext } from './extension-context.factory.js';
import { TELESCOPE_EXTENSIONS } from './telescope.options.js';
```

Add this provider to `SHARED_PROVIDERS` (it needs `ModuleRef`, so it must be a factory injecting `ModuleRef` + config + options):

```ts
  {
    provide: TELESCOPE_EXTENSIONS,
    useFactory: (
      options: TelescopeModuleOptions,
      config: ResolvedCoreConfig,
      moduleRef: ModuleRef,
    ): ExtensionRegistry =>
      new ExtensionRegistry(options.extensions ?? [], createExtensionContext(moduleRef, config)),
    inject: [TELESCOPE_OPTIONS, TELESCOPE_CONFIG, ModuleRef],
  },
```

Ensure `ModuleRef` and `ResolvedCoreConfig` are imported at the top of the file (ModuleRef from `@nestjs/core`; `ResolvedCoreConfig` from `../config/options.js`). Add `TELESCOPE_EXTENSIONS` to the module `exports` array in BOTH `forRoot` and `forRootAsync`.

- [ ] **Step 4: Export the SPI from the package entrypoint**

In `packages/core/src/index.ts`, add:

```ts
export * from './extension/index.js';
export { TELESCOPE_EXTENSIONS } from './nest/telescope.options.js';
```

(Confirm `TELESCOPE_STORAGE` is already exported from `index.ts`; if not, add `export { TELESCOPE_STORAGE } from './nest/telescope.options.js';` — the durable provider needs it.)

- [ ] **Step 5: Verify compile + existing tests still pass**

Run: `pnpm -C packages/core exec tsc --noEmit && pnpm -C packages/core test -- telescope.module`
Expected: PASS (module still constructs; no regressions).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/nest/telescope.options.ts packages/core/src/nest/extension-context.factory.ts packages/core/src/nest/telescope.module.ts packages/core/src/index.ts
git commit -m "feat(core): wire extensions option + TELESCOPE_EXTENSIONS provider"
```

---

## Phase 2 — Core: merge watchers, meta, data route

### Task 4: Merge extension watchers + entry types into registration

**Files:**
- Modify: `packages/core/src/nest/telescope-watcher-registrar.service.ts`
- Test: `packages/core/src/nest/telescope-watcher-registrar.extensions.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/nest/telescope-watcher-registrar.extensions.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { defineTelescopeExtension } from '../extension/types.js';
import { TelescopeModule } from './telescope.module.js';

describe('extension watchers + entry types reach /meta', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('registers an extension watcher and lists its entry type in meta', async () => {
    let registered = false;
    const ext = defineTelescopeExtension({
      name: 'demo',
      watchers: () => [{ type: 'demo', register: () => { registered = true; } }],
      entryTypes: () => [{ id: 'demo', label: 'Demo', dot: 'bg-amber-400' }],
    });
    app = await makeApp({ extensions: [ext] });
    const meta = await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
    expect(registered).toBe(true);
    expect(meta.body.watchers).toContain('demo');
    expect(meta.body.entryTypes).toContainEqual({ id: 'demo', label: 'Demo', dot: 'bg-amber-400' });
  });

  async function makeApp(extra: Record<string, unknown>): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          storage: new InMemoryStorageProvider(),
          ...extra,
        }),
      ],
    }).compile();
    const a = moduleRef.createNestApplication();
    await a.init();
    return a;
  }
});
```

(Confirm the in-memory storage import path matches the repo — the agent referenced `InMemoryStorageProvider`; grep `class InMemoryStorageProvider` if the path differs.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C packages/core test -- telescope-watcher-registrar.extensions.spec.ts`
Expected: FAIL — `meta.body.watchers` lacks `'demo'` and `meta.body.entryTypes` is undefined.

- [ ] **Step 3: Merge extension watchers in the registrar**

In `packages/core/src/nest/telescope-watcher-registrar.service.ts`, inject the registry and merge. Add to imports:

```ts
import { ExtensionRegistry } from '../extension/registry.js';
import { TELESCOPE_EXTENSIONS } from './telescope.options.js';
```

Add the constructor param:

```ts
    @Inject(TELESCOPE_EXTENSIONS) private readonly extensions: ExtensionRegistry,
```

In `onApplicationBootstrap`, change the watcher list to include extension watchers, and append extension entry-type ids to the reported types:

```ts
    const watchers = [...(this.options.watchers ?? []), ...this.extensions.watchers()];
```

After the existing `clientErrorTypes` line, add:

```ts
    const extensionTypes = this.extensions.entryTypes().map((e) => e.id);
    const types = [
      EntryType.Request,
      EntryType.Exception,
      ...registered,
      ...clientErrorTypes,
      ...extensionTypes,
    ];
```

(Replace the existing `const types = [...]` line with the one above.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -C packages/core test -- telescope-watcher-registrar.extensions.spec.ts`
Expected: still FAILS on `meta.body.entryTypes` (added in Task 5) but PASSES on `watchers` containing `'demo'`. Split the assertion: comment out the `entryTypes` assertion, confirm `watchers` passes, then re-enable it — Task 5 makes it pass. (Or write Task 5 before re-running; the registrar change here is correct.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/nest/telescope-watcher-registrar.service.ts packages/core/src/nest/telescope-watcher-registrar.extensions.spec.ts
git commit -m "feat(core): merge extension watchers + entry types into registration"
```

---

### Task 5: Surface entry types + dashboards in `/meta`

**Files:**
- Modify: `packages/core/src/nest/telescope.service.ts`

- [ ] **Step 1: Extend `TelescopeMeta`**

In `packages/core/src/nest/telescope.service.ts`, add to the `TelescopeMeta` interface:

```ts
  /** Entry types contributed by extensions (id/label/dot) — feeds the UI nav. */
  entryTypes: { id: string; label: string; dot: string }[];
  /** Dashboards contributed by extensions (id/label/navGroup) — feeds the UI nav + routes. */
  dashboards: { id: string; label: string; navGroup?: string }[];
```

- [ ] **Step 2: Inject the registry into the service**

Add import + constructor param:

```ts
import { ExtensionRegistry } from '../extension/registry.js';
import { TELESCOPE_EXTENSIONS } from './telescope.options.js';
// ...
    @Inject(TELESCOPE_EXTENSIONS) private readonly extensions: ExtensionRegistry,
```

(Place it with the other `@Inject(...)` constructor params; keep ordering consistent with existing style.)

- [ ] **Step 3: Return them from `getMeta()`**

In the object returned by `getMeta()`, add:

```ts
      entryTypes: this.extensions.entryTypes(),
      dashboards: this.extensions.dashboards().map((d) => ({
        id: d.id,
        label: d.label,
        ...(d.navGroup ? { navGroup: d.navGroup } : {}),
      })),
```

- [ ] **Step 4: Run the Task 4 test (now fully green)**

Re-enable the `entryTypes` assertion in `telescope-watcher-registrar.extensions.spec.ts`.
Run: `pnpm -C packages/core test -- telescope-watcher-registrar.extensions.spec.ts`
Expected: PASS — meta now carries `entryTypes` and `dashboards`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/nest/telescope.service.ts packages/core/src/nest/telescope-watcher-registrar.extensions.spec.ts
git commit -m "feat(core): expose extension entry types + dashboards in /api/meta"
```

---

### Task 6: The data-provider route

**Files:**
- Modify: `packages/core/src/nest/telescope.controller.ts`
- Test: `packages/core/src/nest/telescope.controller.ext.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/nest/telescope.controller.ext.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { defineTelescopeExtension } from '../extension/types.js';
import { TelescopeModule } from './telescope.module.js';

const ext = defineTelescopeExtension({
  name: 'demo',
  dataProviders: () => [
    { name: 'demo.ok', resolve: async (query) => ({ value: (query?.n as number) ?? 0 }) },
    { name: 'demo.boom', resolve: async () => { throw new Error('kaboom'); } },
  ],
});

async function makeApp(authorizer: () => boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      TelescopeModule.forRoot({
        enabled: true,
        authorizer,
        storage: new InMemoryStorageProvider(),
        extensions: [ext],
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('GET /telescope/api/ext/:ext/data/:provider', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('routes to the named provider and passes the query', async () => {
    app = await makeApp(() => true);
    const res = await request(app.getHttpServer())
      .get('/telescope/api/ext/demo/data/demo.ok?n=7')
      .expect(200);
    expect(res.body).toEqual({ value: 7 });
  });

  it('returns 404 for an unknown provider', async () => {
    app = await makeApp(() => true);
    await request(app.getHttpServer()).get('/telescope/api/ext/demo/data/nope').expect(404);
  });

  it('returns a 502 error payload when the provider throws', async () => {
    app = await makeApp(() => true);
    const res = await request(app.getHttpServer())
      .get('/telescope/api/ext/demo/data/demo.boom')
      .expect(502);
    expect(res.body.message).toMatch(/kaboom/);
  });

  it('is gated by the read guard (403 when unauthorized)', async () => {
    app = await makeApp(() => false);
    await request(app.getHttpServer()).get('/telescope/api/ext/demo/data/demo.ok').expect(403);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C packages/core test -- telescope.controller.ext.spec.ts`
Expected: FAIL — route not found (404 on the happy path too).

- [ ] **Step 3: Implement the route**

In `packages/core/src/nest/telescope.controller.ts`, add imports:

```ts
import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ExtensionRegistry } from '../extension/registry.js';
import { createExtensionContext } from './extension-context.factory.js';
import { TELESCOPE_CONFIG, TELESCOPE_EXTENSIONS } from './telescope.options.js';
import type { ResolvedCoreConfig } from '../config/options.js';
```

Add constructor params (alongside the existing injected deps):

```ts
    @Inject(TELESCOPE_EXTENSIONS) private readonly extensions: ExtensionRegistry,
    @Inject(TELESCOPE_CONFIG) private readonly extConfig: ResolvedCoreConfig,
    private readonly moduleRef: ModuleRef,
```

Add the route method (the controller already has `@UseGuards(TelescopeGuard)` at class level, so the read gate applies automatically):

```ts
  @Get('ext/:ext/data/:provider')
  async extData(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
  ): Promise<unknown> {
    const found = this.extensions.findProvider(provider);
    if (!found) throw new NotFoundException(`Unknown data provider "${provider}".`);
    const ctx = createExtensionContext(this.moduleRef, this.extConfig);
    try {
      return await found.resolve(query, ctx);
    } catch (error) {
      throw new BadGatewayException((error as Error).message);
    }
  }
```

Note: the `:ext` segment is part of the namespace/URL contract but the provider name is globally unique, so resolution keys off `provider`. Keep `:ext` in the path for stable, readable URLs and future per-extension scoping.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -C packages/core test -- telescope.controller.ext.spec.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/nest/telescope.controller.ts packages/core/src/nest/telescope.controller.ext.spec.ts
git commit -m "feat(core): add gated GET /api/ext/:ext/data/:provider route"
```

---

## Phase 3 — UI: dynamic nav + panel renderer

### Task 7: Meta types + the data hook + client method

**Files:**
- Modify: the UI `TelescopeClient` (grep `class TelescopeClient` / `meta()` under `packages/ui/src`) and its meta type.
- Create: `packages/ui/src/app/hooks/use-extension-data.ts`

- [ ] **Step 1: Extend the client meta type + add `extData`**

Find the client (the agent noted `client.meta()`); in its meta return type add the two arrays mirroring core:

```ts
  entryTypes?: { id: string; label: string; dot: string }[];
  dashboards?: { id: string; label: string; navGroup?: string }[];
```

Add a fetch method next to `meta()`:

```ts
  async extData(ext: string, provider: string, query?: Record<string, unknown>): Promise<unknown> {
    const qs = query ? `?${new URLSearchParams(query as Record<string, string>).toString()}` : '';
    return this.request(`ext/${encodeURIComponent(ext)}/data/${encodeURIComponent(provider)}${qs}`);
  }
```

(Use whatever the client's existing private `request`/`get` helper is named — match the pattern used by `meta()`.)

- [ ] **Step 2: Write the data hook (with a thin test)**

```ts
// packages/ui/src/app/hooks/use-extension-data.ts
import { useQuery } from '@tanstack/react-query';
import { useClient } from '../client-context.js'; // match the existing client hook/context import

/** Fetch a panel's data from a named extension data provider. */
export function useExtensionData(ext: string, provider: string, query?: Record<string, unknown>) {
  const client = useClient();
  return useQuery({
    queryKey: ['ext-data', ext, provider, query],
    queryFn: () => client.extData(ext, provider, query),
  });
}
```

(Confirm the data-fetching lib — the agent showed `useMeta()` / react-query usage. Match the existing hook style exactly; if the UI uses a different client-access pattern than `useClient()`, mirror what `useMeta` does.)

- [ ] **Step 3: Verify compile**

Run: `pnpm -C packages/ui exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src
git commit -m "feat(ui): meta types for extensions + useExtensionData hook"
```

---

### Task 8: The panel renderer

**Files:**
- Create: `packages/ui/src/react/components/extensions/stat-card.tsx`
- Create: `packages/ui/src/react/components/extensions/panel-renderer.tsx`
- Test: `packages/ui/src/react/components/extensions/panel-renderer.spec.tsx`

- [ ] **Step 1: Extract the shared StatCard**

Move the private `StatCard` from `packages/ui/src/app/pages/OverviewPage.tsx` into a shared component and re-import it there (so there is one StatCard):

```tsx
// packages/ui/src/react/components/extensions/stat-card.tsx
import type { JSX } from 'react';

export function StatCard({
  label,
  value,
  accent = 'text-zinc-100',
  hint,
}: {
  label: string;
  value: string | number;
  accent?: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${accent}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-zinc-600">{hint}</p>}
    </div>
  );
}
```

In `OverviewPage.tsx`, delete the local `StatCard` definition and add `import { StatCard } from '../../react/components/extensions/stat-card.js';` (fix the relative path to match the file). Run `pnpm -C packages/ui test -- OverviewPage` to confirm no regression.

- [ ] **Step 2: Write the failing renderer test**

```tsx
// packages/ui/src/react/components/extensions/panel-renderer.spec.tsx
import { cloneElement, isValidElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  function Mock({ children }: { children: React.ReactNode }): JSX.Element {
    return <div>{isValidElement(children) ? cloneElement(children, { width: 600, height: 300 }) : children}</div>;
  }
  return { ...actual, ResponsiveContainer: Mock };
});

import { PanelView } from './panel-renderer.js';

describe('PanelView (pure render from resolved data)', () => {
  it('renders a stat panel with a percent format', () => {
    render(<PanelView panel={{ kind: 'stat', title: 'Success rate', data: { provider: 'p' }, format: 'percent' }} data={{ value: 0.97 }} />);
    expect(screen.getByText('Success rate')).toBeTruthy();
    expect(screen.getByText('97%')).toBeTruthy();
  });

  it('renders a table panel with deep-linked rows', () => {
    render(
      <PanelView
        panel={{ kind: 'table', title: 'Recent failures', data: { provider: 'p' },
          columns: [{ key: 'workflow', label: 'Workflow' }, { key: 'runId', label: 'Run', link: { href: '/durable/runs/{runId}' } }] }}
        data={{ rows: [{ workflow: 'checkout', runId: 'r1' }] }}
      />,
    );
    expect(screen.getByText('checkout')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'r1' });
    expect(link.getAttribute('href')).toBe('/durable/runs/r1');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm -C packages/ui test -- panel-renderer.spec.tsx`
Expected: FAIL — `PanelView` not defined.

- [ ] **Step 4: Implement the renderer**

`PanelView` is the **pure** view (panel + resolved data → JSX), so it is trivially testable. `PanelRenderer` (next task wires it) binds the data via the hook and renders `PanelView`.

```tsx
// packages/ui/src/react/components/extensions/panel-renderer.tsx
import type { JSX } from 'react';
import { AreaChartCard } from '../charts/area-chart-card.js';
import { StackedAreaChartCard } from '../charts/stacked-area-chart-card.js';
import { BarChartCard } from '../charts/bar-chart-card.js';
import { StatCard } from './stat-card.js';

// Mirror of core's Panel union (UI-local copy to avoid a core import cycle).
export type Panel =
  | { kind: 'stat'; title: string; data: { provider: string; query?: Record<string, unknown> }; format?: 'number' | 'percent' | 'duration'; accent?: string }
  | { kind: 'timeseries'; title: string; data: { provider: string; query?: Record<string, unknown> }; series: string[]; style?: 'area' | 'stacked' }
  | { kind: 'topN'; title: string; data: { provider: string; query?: Record<string, unknown> }; limit?: number }
  | { kind: 'table'; title: string; data: { provider: string; query?: Record<string, unknown> }; columns: { key: string; label: string; link?: { href: string; external?: boolean } }[] };

function formatStat(value: number, format?: 'number' | 'percent' | 'duration'): string {
  if (format === 'percent') return `${Math.round(value * 100)}%`;
  if (format === 'duration') return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
  return new Intl.NumberFormat().format(value);
}

function fillTemplate(href: string, row: Record<string, unknown>): string {
  return href.replace(/\{(\w+)\}/g, (_m, k: string) => String(row[k] ?? ''));
}

/** Pure view: render a panel from already-resolved data. */
export function PanelView({ panel, data }: { panel: Panel; data: unknown }): JSX.Element {
  switch (panel.kind) {
    case 'stat': {
      const d = (data ?? {}) as { value?: number };
      return <StatCard label={panel.title} value={formatStat(d.value ?? 0, panel.format)} accent={panel.accent} />;
    }
    case 'timeseries': {
      const rows = ((data as { rows?: Array<{ label: string } & Record<string, number>> })?.rows) ?? [];
      return panel.style === 'stacked'
        ? <StackedAreaChartCard title={panel.title} data={rows} series={panel.series} />
        : <AreaChartCard title={panel.title} data={rows.map((r) => ({ label: r.label, value: Number(r[panel.series[0]] ?? 0) }))} />;
    }
    case 'topN': {
      const items = ((data as { items?: Array<{ label: string; value: number; id?: string }> })?.items) ?? [];
      const limited = panel.limit ? items.slice(0, panel.limit) : items;
      return <BarChartCard title={panel.title} data={limited} horizontal truncateLabel={32} />;
    }
    case 'table': {
      const rows = ((data as { rows?: Record<string, unknown>[] })?.rows) ?? [];
      return (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
          <p className="border-b border-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300">{panel.title}</p>
          <table className="w-full text-sm">
            <thead>
              <tr>{panel.columns.map((c) => <th key={c.key} className="px-4 py-2 text-left text-[10px] uppercase tracking-wide text-zinc-500">{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-t border-zinc-800/60">
                  {panel.columns.map((c) => {
                    const text = String(row[c.key] ?? '');
                    return (
                      <td key={c.key} className="px-4 py-2 text-zinc-200">
                        {c.link
                          ? <a className="text-sky-400 hover:underline" href={fillTemplate(c.link.href, row)} {...(c.link.external ? { target: '_blank', rel: 'noreferrer' } : {})}>{text}</a>
                          : text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm -C packages/ui test -- panel-renderer.spec.tsx`
Expected: PASS (both cases). Also run `pnpm -C packages/ui test -- OverviewPage` to confirm the StatCard extraction didn't regress.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/react/components/extensions packages/ui/src/app/pages/OverviewPage.tsx
git commit -m "feat(ui): PanelView renderer for the extension panel IR + shared StatCard"
```

---

### Task 9: The dashboard page + dynamic nav

**Files:**
- Create: `packages/ui/src/app/pages/extension-dashboard-page.tsx`
- Modify: `packages/ui/src/app/App.tsx`
- Modify: `packages/ui/src/app/dashboard-layout.tsx`
- Modify: `packages/ui/src/react/components/entry-types.ts`
- Test: `packages/ui/src/app/pages/extension-dashboard-page.spec.tsx`

- [ ] **Step 1: The data-bound panel wrapper + page**

```tsx
// packages/ui/src/app/pages/extension-dashboard-page.tsx
import type { JSX } from 'react';
import { useParams } from 'react-router-dom';
import { useMeta } from '../hooks/use-meta.js'; // match existing meta hook import
import { useExtensionData } from '../hooks/use-extension-data.js';
import { PanelView, type Panel } from '../../react/components/extensions/panel-renderer.js';

// The full DashboardSpec carried by meta needs panels; if meta currently only carries
// {id,label,navGroup}, extend the core meta `dashboards` mapping in Task 5 to include
// `panels: d.panels` and add `panels: Panel[]` to the UI meta type. (See note below.)
function BoundPanel({ ext, panel }: { ext: string; panel: Panel }): JSX.Element {
  const q = useExtensionData(ext, panel.data.provider, panel.data.query);
  if (q.isError) return <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">Failed to load “{panel.title}”.</div>;
  return <PanelView panel={panel} data={q.data} />;
}

export function ExtensionDashboardPage(): JSX.Element {
  const { dashboardId } = useParams();
  const meta = useMeta();
  const dash = meta.data?.dashboards?.find((d) => d.id === dashboardId);
  if (!dash) return <div className="p-6 text-sm text-zinc-400">Dashboard not found.</div>;
  const ext = dashboardId?.split('.')[0] ?? '';
  return (
    <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
      {dash.panels.map((panel, i) => <BoundPanel key={i} ext={ext} panel={panel} />)}
    </div>
  );
}
```

**Note (amends Task 5):** the panels must reach the UI. Update Task 5's `getMeta()` dashboards mapping to include `panels: d.panels`, and add `panels: Panel[]` to the UI meta `dashboards` type (Task 7). The `ext` is derived from the convention that a dashboard id is `"<extName>.<page>"` (e.g. `durable.workflows`), so panels resolve against provider names the same extension registered. Document this convention in the extensions doc (Phase 5).

- [ ] **Step 2: Add the route**

In `packages/ui/src/app/App.tsx`, inside `<Routes>`:

```tsx
          <Route path="/ext/:dashboardId" element={<ExtensionDashboardPage />} />
```

(Import `ExtensionDashboardPage` at the top.)

- [ ] **Step 3: Dynamic nav**

In `packages/ui/src/app/dashboard-layout.tsx`, after the watcher nav block, render extension dashboards from meta:

```tsx
        {(meta.data?.dashboards ?? []).map((d) => (
          <NavLink key={d.id} to={`/ext/${d.id}`} className={topLinkClass}>
            {d.label}
          </NavLink>
        ))}
```

And feed extension entry types into the entries nav. In `packages/ui/src/react/components/entry-types.ts`, add a helper that merges meta-provided extension entry types with the built-in `ENTRY_TYPES` before `visibleEntryTypes` filters them:

```ts
/** Built-in types plus extension-contributed ones (from /api/meta). */
export function allEntryTypes(
  extension: readonly { id: string; label: string; dot: string }[] | undefined,
): EntryTypeDef[] {
  const extras = (extension ?? []).map((e) => ({ id: e.id, label: e.label, dot: e.dot }));
  // Drop any extension type that collides with a built-in id (built-in wins).
  const builtinIds = new Set(ENTRY_TYPES.map((t) => t.id));
  return [...ENTRY_TYPES, ...extras.filter((e) => !builtinIds.has(e.id))];
}
```

In `dashboard-layout.tsx`, change the watcher-types line to:

```tsx
  const watcherTypes = visibleEntryTypes(allEntryTypes(meta.data?.entryTypes), meta.data?.watchers);
```

- [ ] **Step 4: Write the page test**

```tsx
// packages/ui/src/app/pages/extension-dashboard-page.spec.tsx
import { cloneElement, isValidElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  function Mock({ children }: { children: React.ReactNode }): JSX.Element {
    return <div>{isValidElement(children) ? cloneElement(children, { width: 600, height: 300 }) : children}</div>;
  }
  return { ...actual, ResponsiveContainer: Mock };
});

// Stub the meta + data hooks to render a known spec without a server.
vi.mock('../hooks/use-meta.js', () => ({
  useMeta: () => ({ data: { dashboards: [{ id: 'demo.page', label: 'Demo', panels: [
    { kind: 'stat', title: 'Success rate', data: { provider: 'demo.rate' }, format: 'percent' },
  ] }] } }),
}));
vi.mock('../hooks/use-extension-data.js', () => ({
  useExtensionData: () => ({ data: { value: 0.95 }, isError: false }),
}));

import { ExtensionDashboardPage } from './extension-dashboard-page.js';

describe('ExtensionDashboardPage', () => {
  it('renders panels from the meta dashboard spec', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/ext/demo.page']}>
          <Routes><Route path="/ext/:dashboardId" element={<ExtensionDashboardPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Success rate')).toBeTruthy());
    expect(screen.getByText('95%')).toBeTruthy();
  });
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm -C packages/ui test -- extension-dashboard-page.spec.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/app/pages/extension-dashboard-page.tsx packages/ui/src/app/App.tsx packages/ui/src/app/dashboard-layout.tsx packages/ui/src/react/components/entry-types.ts packages/ui/src/app/pages/extension-dashboard-page.spec.tsx
git commit -m "feat(ui): extension dashboard page + dynamic nav from /api/meta"
```

---

## Phase 4 — Durable consumer

> Work in the `nestjs-durable` repo (`packages/telescope`). Branch first there too.

### Task 10: Durable data providers

**Files:**
- Create: `packages/telescope/src/durable-data-providers.ts`
- Test: `packages/telescope/src/durable-data-providers.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/telescope/src/durable-data-providers.spec.ts (nestjs-durable repo)
import { describe, expect, it } from 'vitest';
import type { ExtensionContext } from '@dudousxd/nestjs-telescope';
import { durableStateProvider } from './durable-data-providers.js';

// Minimal fake store: only listRuns is exercised.
function fakeStore(byStatus: Record<string, number>) {
  return {
    listRuns: async ({ status }: { status?: string }) =>
      Array.from({ length: status ? (byStatus[status] ?? 0) : 0 }, (_, i) => ({ id: `${status}-${i}` })),
  };
}

function ctxWith(store: unknown): ExtensionContext {
  return {
    config: {} as ExtensionContext['config'],
    moduleRef: { get: () => store } as unknown as ExtensionContext['moduleRef'],
  };
}

describe('durableStateProvider', () => {
  it('returns current-state gauges counted from the store', async () => {
    const provider = durableStateProvider();
    const result = (await provider.resolve(undefined, ctxWith(
      fakeStore({ dead: 2, running: 3, suspended: 1, pending: 4 }),
    ))) as { value: number };
    // query.status selects which gauge; default 'dead'
    expect(result.value).toBe(2);
  });

  it('counts the requested status', async () => {
    const provider = durableStateProvider();
    const result = (await provider.resolve({ status: 'running' }, ctxWith(
      fakeStore({ dead: 2, running: 3 }),
    ))) as { value: number };
    expect(result.value).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (in `nestjs-durable`): `pnpm -C packages/telescope test -- durable-data-providers.spec.ts`
Expected: FAIL — `durableStateProvider` not defined.

- [ ] **Step 3: Implement the providers**

```ts
// packages/telescope/src/durable-data-providers.ts (nestjs-durable repo)
import type { DataProvider, ExtensionContext } from '@dudousxd/nestjs-telescope';
import { TELESCOPE_STORAGE } from '@dudousxd/nestjs-telescope';
import { STATE_STORE } from '@dudousxd/nestjs-durable-core';
import type { RunStatus, StateStore } from '@dudousxd/nestjs-durable-core';

const STATE_CAP = 10_000;

/** Source C: current-state gauge from the durable store. query.status selects which. */
export function durableStateProvider(): DataProvider {
  return {
    name: 'durable.state',
    async resolve(query, ctx: ExtensionContext) {
      const store = ctx.moduleRef.get<StateStore>(STATE_STORE, { strict: false });
      const status = ((query?.status as RunStatus) ?? 'dead') satisfies RunStatus;
      const runs = await store.listRuns({ status, limit: STATE_CAP });
      return { value: runs.length };
    },
  };
}

/**
 * Source A: rollups from captured `durable` entries in Telescope's own storage.
 * Reads recent run.* lifecycle entries and aggregates. Bounded by Telescope's prune
 * window (by design — this is the "history" series, not the source of truth).
 */
export function durableTimeseriesProvider(): DataProvider {
  return {
    name: 'durable.timeseries',
    async resolve(query, ctx: ExtensionContext) {
      // TELESCOPE_STORAGE exposes `get(query): Promise<Page<Entry>>` (newest-first).
      const storage = ctx.moduleRef.get<{
        get(q: { type?: string; limit?: number }): Promise<{ entries: Array<{ content?: unknown; createdAt?: Date }> }>;
      }>(TELESCOPE_STORAGE, { strict: false });
      const limit = Math.min(5_000, Math.max(100, Number(query?.limit ?? 2_000)));
      const page = await storage.get({ type: 'durable', limit });

      // Each entry's content carries { event, workflow }. We only count terminal run events.
      let completed = 0;
      let failed = 0;
      const failByWorkflow = new Map<string, number>();
      for (const e of page.entries) {
        const c = (e.content ?? {}) as { event?: string; workflow?: string };
        if (c.event === 'run.completed') completed += 1;
        else if (c.event === 'run.failed') {
          failed += 1;
          const wf = c.workflow ?? 'unknown';
          failByWorkflow.set(wf, (failByWorkflow.get(wf) ?? 0) + 1);
        }
      }
      const total = completed + failed;
      const metric = (query?.metric as string) ?? 'successRate';
      if (metric === 'successRate') return { value: total === 0 ? 1 : completed / total };
      if (metric === 'failed') return { value: failed };
      if (metric === 'total') return { value: total };
      if (metric === 'topFailures') {
        const items = [...failByWorkflow.entries()]
          .map(([label, value]) => ({ label, value }))
          .sort((a, b) => b.value - a.value);
        return { items };
      }
      return { value: total };
    },
  };
}
```

(Confirm `Page<Entry>` field name — the core `Page<T>` type from `storage-provider.ts` has an entries array; match its exact property name, e.g. `data` vs `entries`, by reading `interface Page<T>`. Adjust the inline type accordingly.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -C packages/telescope test -- durable-data-providers.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/telescope/src/durable-data-providers.ts packages/telescope/src/durable-data-providers.spec.ts
git commit -m "feat(telescope): durable.state (store gauges) + durable.timeseries (captured entries) providers"
```

---

### Task 11: The dashboard spec + the extension

**Files:**
- Create: `packages/telescope/src/durable-dashboard.spec-data.ts`
- Create: `packages/telescope/src/durable-telescope.extension.ts`
- Modify: `packages/telescope/src/index.ts`
- Test: `packages/telescope/src/durable-telescope.extension.spec.ts`

- [ ] **Step 1: Write the dashboard spec factory**

```ts
// packages/telescope/src/durable-dashboard.spec-data.ts (nestjs-durable repo)
import type { DashboardSpec } from '@dudousxd/nestjs-telescope';

/**
 * The "Workflows" health dashboard. `runHref` is a URL template for deep-linking a run
 * out to the durable dashboard (e.g. '/durable/runs/{runId}'); default points at the
 * durable dashboard's run route.
 */
export function durableDashboard(opts: { runHref?: string } = {}): DashboardSpec {
  const runHref = opts.runHref ?? '/durable/runs/{runId}';
  return {
    id: 'durable.workflows',
    label: 'Workflows',
    panels: [
      { kind: 'stat', title: 'Success rate', data: { provider: 'durable.timeseries', query: { metric: 'successRate' } }, format: 'percent', accent: 'text-emerald-400' },
      { kind: 'stat', title: 'Failed (window)', data: { provider: 'durable.timeseries', query: { metric: 'failed' } }, accent: 'text-red-400' },
      { kind: 'stat', title: 'Dead now', data: { provider: 'durable.state', query: { status: 'dead' } }, accent: 'text-red-400' },
      { kind: 'stat', title: 'Suspended now', data: { provider: 'durable.state', query: { status: 'suspended' } } },
      { kind: 'stat', title: 'Running now', data: { provider: 'durable.state', query: { status: 'running' } } },
      { kind: 'stat', title: 'Pending now', data: { provider: 'durable.state', query: { status: 'pending' } } },
      { kind: 'topN', title: 'Top failing workflows', data: { provider: 'durable.timeseries', query: { metric: 'topFailures' } }, limit: 10 },
      { kind: 'table', title: 'Recent failed runs', data: { provider: 'durable.recentFailures' },
        columns: [
          { key: 'workflow', label: 'Workflow' },
          { key: 'runId', label: 'Run', link: { href: runHref } },
          { key: 'error', label: 'Error' },
        ] },
    ],
  };
}
```

**Note:** this adds a third provider `durable.recentFailures`. Add it to `durable-data-providers.ts` (a `table` provider returning `{ rows }`):

```ts
// append to durable-data-providers.ts
export function durableRecentFailuresProvider(): DataProvider {
  return {
    name: 'durable.recentFailures',
    async resolve(query, ctx: ExtensionContext) {
      const store = ctx.moduleRef.get<StateStore>(STATE_STORE, { strict: false });
      const limit = Math.min(200, Math.max(10, Number(query?.limit ?? 50)));
      const [failed, dead] = await Promise.all([
        store.listRuns({ status: 'failed', limit }),
        store.listRuns({ status: 'dead', limit }),
      ]);
      const rows = [...failed, ...dead]
        .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
        .slice(0, limit)
        .map((r) => ({ workflow: r.workflow, runId: r.id, error: r.error?.message ?? '' }));
      return { rows };
    },
  };
}
```

(Add a quick test case for `durableRecentFailuresProvider` mirroring Task 10's fake-store pattern — assert it returns `{ rows }` sorted newest-first.)

- [ ] **Step 2: Write the extension + its test**

```ts
// packages/telescope/src/durable-telescope.extension.ts (nestjs-durable repo)
import { defineTelescopeExtension } from '@dudousxd/nestjs-telescope';
import { DurableTelescopeWatcher } from './durable-telescope.watcher.js';
import {
  durableRecentFailuresProvider,
  durableStateProvider,
  durableTimeseriesProvider,
} from './durable-data-providers.js';
import { durableDashboard } from './durable-dashboard.spec-data.js';

/** The first-class Telescope extension for nestjs-durable: watcher + Workflows dashboard. */
export function durableTelescopeExtension(opts: { runHref?: string } = {}) {
  return defineTelescopeExtension({
    name: 'durable',
    watchers: () => [new DurableTelescopeWatcher()],
    entryTypes: () => [{ id: 'durable', label: 'Workflows', dot: 'bg-amber-400' }],
    dashboards: () => [durableDashboard(opts)],
    dataProviders: () => [
      durableStateProvider(),
      durableTimeseriesProvider(),
      durableRecentFailuresProvider(),
    ],
  });
}
```

```ts
// packages/telescope/src/durable-telescope.extension.spec.ts
import { describe, expect, it } from 'vitest';
import type { ExtensionContext } from '@dudousxd/nestjs-telescope';
import { durableTelescopeExtension } from './durable-telescope.extension.js';

const ctx = { config: {}, moduleRef: {} } as unknown as ExtensionContext;

describe('durableTelescopeExtension', () => {
  it('bundles the watcher, entry type, dashboard, and three providers', () => {
    const ext = durableTelescopeExtension();
    expect(ext.name).toBe('durable');
    expect(ext.watchers?.(ctx).map((w) => w.type)).toEqual(['durable']);
    expect(ext.entryTypes?.(ctx)).toEqual([{ id: 'durable', label: 'Workflows', dot: 'bg-amber-400' }]);
    expect(ext.dashboards?.(ctx).map((d) => d.id)).toEqual(['durable.workflows']);
    expect(ext.dataProviders?.(ctx).map((p) => p.name).sort()).toEqual(
      ['durable.recentFailures', 'durable.state', 'durable.timeseries'],
    );
  });
});
```

- [ ] **Step 3: Export from index (keep back-compat)**

```ts
// packages/telescope/src/index.ts
export * from './durable-telescope.watcher';
export * from './durable-telescope.extension';
export * from './durable-data-providers';
export * from './durable-dashboard.spec-data';
```

- [ ] **Step 4: Run the durable telescope tests**

Run: `pnpm -C packages/telescope test`
Expected: PASS (new extension + provider tests + the existing watcher test).

- [ ] **Step 5: Commit**

```bash
git add packages/telescope/src
git commit -m "feat(telescope): durableTelescopeExtension() — Workflows dashboard as a Telescope extension"
```

---

### Task 12: End-to-end wiring check

**Files:**
- Test: `packages/telescope/src/durable-telescope.e2e.spec.ts`

- [ ] **Step 1: Write an integration test booting Telescope with the durable extension**

```ts
// packages/telescope/src/durable-telescope.e2e.spec.ts (nestjs-durable repo)
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { WorkflowEngine, InMemoryStateStore, STATE_STORE } from '@dudousxd/nestjs-durable-core';
import { durableTelescopeExtension } from './durable-telescope.extension.js';

describe('durable extension end-to-end in Telescope', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('exposes the Workflows dashboard in /meta and serves durable.state', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          extensions: [durableTelescopeExtension()],
        }),
      ],
      providers: [
        { provide: WorkflowEngine, useValue: engine },
        { provide: STATE_STORE, useValue: store },
      ],
      exports: [WorkflowEngine, STATE_STORE],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const meta = await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
    expect(meta.body.dashboards.map((d: { id: string }) => d.id)).toContain('durable.workflows');
    expect(meta.body.entryTypes.map((e: { id: string }) => e.id)).toContain('durable');

    const state = await request(app.getHttpServer())
      .get('/telescope/api/ext/durable/data/durable.state?status=dead')
      .expect(200);
    expect(state.body).toEqual({ value: 0 });
  });
});
```

(Confirm `InMemoryStateStore` is exported from `@dudousxd/nestjs-durable-core` — the watcher spec already uses it. If the engine must be globally resolvable via `moduleRef.get(WorkflowEngine, { strict: false })`, providing it in the same test module as above is sufficient.)

- [ ] **Step 2: Run it**

Run: `pnpm -C packages/telescope test -- durable-telescope.e2e.spec.ts`
Expected: PASS — `/meta` carries `durable.workflows` + the `durable` entry type, and the data route returns the gauge.

- [ ] **Step 3: Commit**

```bash
git add packages/telescope/src/durable-telescope.e2e.spec.ts
git commit -m "test(telescope): e2e — durable extension surfaces in /meta + data route"
```

---

## Phase 5 — Documentation

### Task 13: Telescope docs — concept + recipe + config

**Files (nestjs-telescope repo):**
- Create: `website/content/docs/concepts/extensions.mdx`
- Create: `website/content/docs/recipes/building-an-extension.mdx`
- Modify: `website/content/docs/reference/configuration.mdx`
- Modify: `website/content/docs/packages/index.mdx`
- Modify: the relevant `meta.json` files (concepts + recipes) to list the new pages.

- [ ] **Step 1: Write `concepts/extensions.mdx`**

Frontmatter + content covering: what an extension is (mirror the `Watcher` concept page tone), the `TelescopeExtension` contract (the four hooks), the panel IR (`stat`/`timeseries`/`topN`/`table`) and how the fixed UI renders it (no React shipped by the extension), dynamic nav, the data-provider flow (`GET /api/ext/:ext/data/:provider`, gated by the read `authorizer`), the dashboard-id convention `"<extName>.<page>"`, and the collision rules. Include the `durable` example as the canonical consumer.

```mdx
---
title: Extensions
description: Contribute navigable entry types, declarative dashboards, and data providers to Telescope from your own library.
---
```

(Write the full prose + code samples — the `defineTelescopeExtension` shape, a minimal stat-only dashboard, and the registration via `forRoot({ extensions: [...] })`.)

- [ ] **Step 2: Write `recipes/building-an-extension.mdx`**

A step-by-step authoring guide (sibling to `recipes/custom-watcher.mdx`): define the extension, add an entry type, add a data provider that resolves a host service via `ctx.moduleRef`, add a dashboard spec, register it. Show the `durableTelescopeExtension()` source as the worked example.

- [ ] **Step 3: Update `reference/configuration.mdx`**

Document the `extensions?: TelescopeExtension[]` `forRoot` option next to `watchers`.

- [ ] **Step 4: Update `packages/index.mdx` + nav `meta.json`**

Add a line pointing to the new concept page; add `"extensions"` to `concepts/meta.json` pages and `"building-an-extension"` to `recipes/meta.json` pages.

- [ ] **Step 5: Build the docs site to verify no broken MDX/links**

Run: `pnpm -C website build`
Expected: PASS (no MDX parse errors, no broken internal links).

- [ ] **Step 6: Commit**

```bash
git add website/content/docs
git commit -m "docs: extension SPI concept + authoring recipe + config reference"
```

---

### Task 14: Durable docs — Workflows dashboard

**Files (nestjs-durable repo):**
- Modify: `website/content/docs/observability/telescope.mdx`

- [ ] **Step 1: Extend the page**

Keep the existing watcher section (back-compat). Add a "Workflows dashboard" section documenting `durableTelescopeExtension()`: how to register it (`TelescopeModule.forRoot({ extensions: [durableTelescopeExtension({ runHref })] })`), what the dashboard shows (success rate, failed/window, current-state gauges dead/suspended/running/pending, top failing workflows, recent failures table), the data sources (captured entries + the durable store), and that per-run actions/graph deep-link out to the durable dashboard via `runHref`. Cross-link to the Telescope "Extensions" concept page.

```mdx
## Workflows dashboard

`durableTelescopeExtension()` upgrades the watcher into a first-class Telescope
extension: it registers the **Workflows** nav tab with a health dashboard, alongside
the entries the watcher already records.

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { durableTelescopeExtension } from '@dudousxd/nestjs-durable-telescope';

TelescopeModule.forRoot({
  extensions: [durableTelescopeExtension({ runHref: '/durable/runs/{runId}' })],
});
```
```

- [ ] **Step 2: Build the durable docs site**

Run: `pnpm -C website build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add website/content/docs/observability/telescope.mdx
git commit -m "docs(observability): document the durable Telescope extension Workflows dashboard"
```

---

## Phase 6 — Finalize

### Task 15: Full suites + changesets

- [ ] **Step 1: Run the full test suites in both repos**

Run (telescope): `pnpm -C packages/core test && pnpm -C packages/ui test`
Run (durable): `pnpm -C packages/telescope test`
Expected: all PASS.

- [ ] **Step 2: Typecheck both repos**

Run: `pnpm -C packages/core exec tsc --noEmit && pnpm -C packages/ui exec tsc --noEmit`
Run (durable): `pnpm -C packages/telescope exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Add changesets**

Both repos use changesets (per memory `nestjs-libs-release-flow`). Add a minor changeset in `nestjs-telescope` (core + ui: "extension SPI + declarative dashboard panels") and in `nestjs-durable` (telescope package: "durableTelescopeExtension Workflows dashboard"). Use `pnpm changeset` and follow the existing prompt; mark `@dudousxd/nestjs-telescope`, `@dudousxd/nestjs-telescope-ui`, and `@dudousxd/nestjs-durable-telescope` as `minor`.

- [ ] **Step 4: Commit**

```bash
git add .changeset
git commit -m "chore: changesets for extension SPI + durable Workflows dashboard"
```

---

## Self-review notes

- **Spec coverage:** SPI contract (Task 1), registry + collisions (Task 2), `extensions` option + provider (Task 3), watcher merge + entry types (Task 4), meta dashboards/entryTypes (Task 5), data route + gate + error handling (Task 6), dynamic nav (Tasks 7+9), panel renderer covering all four IR kinds (Task 8), durable consumer A+C providers (Tasks 10–11), e2e (Task 12), docs in both repos (Tasks 13–14). All spec sections map to a task.
- **Deferred/non-goals respected:** no single-slot hooks (registry shaped for them, none shipped); no management actions in Telescope (table deep-links out via `runHref`); no federation/iframe (declarative IR only); durable graph stays a deep-link (not modeled in the IR).
- **Cross-task type consistency:** `Panel`/`DataBinding`/`DataProvider` defined in Task 1 are reused verbatim in Tasks 6, 8, 10, 11; the UI keeps a local mirror of `Panel` (Task 8) to avoid a core→ui import — keep the two in sync (documented in the renderer file).
- **Known confirmations to make while implementing (not placeholders — exact-path checks):** the `Page<T>` property name (`entries` vs `data`) in `storage-provider.ts` (Task 10 Step 3); the in-memory storage class import path (Task 4); the UI client's request-helper + meta-hook names (Task 7). Each task notes the grep to run.
