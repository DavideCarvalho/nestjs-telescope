# Implementation Plan — Inertia Debug Panel for nestjs-telescope

**Date:** 2026-06-09
**Spec:** `docs/superpowers/specs/2026-06-09-inertia-telescope-panel-design.md`
**Spans:** `nestjs-inertia` (producer) ↔ `nestjs-telescope` (consumer + UI)

This plan is grounded in the real code of both repos (verified file/line refs below).
Three independently-shippable phases that map 1:1 to spec §8:

- **Phase A** — `nestjs-inertia` emits one `diagnostics_channel` event per render.
- **Phase B** — `nestjs-telescope` adds `packages/inertia-watcher` that subscribes,
  validates, and records an entry.
- **Phase C** — `nestjs-telescope` UI renders the rich Inertia panel.

Each phase is green on its own: A costs ~zero and ships safely with nothing watching;
B makes data appear under the generic entries view; C adds the panel.

---

## Cross-repo contract (the wire — must stay byte-identical on both sides)

- **Channel name (the contract):** `"nestjs-inertia:render"`.
  - Exported from inertia as `INERTIA_DIAG_CHANNEL`.
  - **Hardcoded** as a local `const INERTIA_CHANNEL` in the telescope watcher.
    Telescope must NOT import inertia at runtime (decoupling). The string is the contract.
- **Payload type `InertiaRenderDiagnostic`** (spec §1.3): a type-only export on the
  inertia side; structurally re-declared + defensively validated on the telescope side.
- **Versioned by `v: 1`** inside the payload. The watcher drops any payload whose
  `v !== 1` or that fails structural validation — never throws.
- **Correlation = synchronous publish.** `diagnostics_channel.publish()` invokes
  subscribers synchronously on the caller's stack, so `InertiaService.render()` →
  `publish()` → `InertiaWatcher.safeRecord()` → `ctx.record()` all run inside the
  request's ALS batch that Telescope's request watcher opened. No request-id field.

### Verified grounding (read before editing)

**nestjs-inertia (`packages/core`):**
- `src/service.ts:292` `render()`; 409 short-circuit `src/service.ts:294-303`;
  marker loop `src/service.ts:347-440` (branches on `getMarkerKind`:
  `always`/`optional`/`once`/`defer`/`merge` — confirmed against `src/markers.ts:12`);
  `sharedProps` computed at `src/service.ts:321`; `PageObject` assembly
  `src/service.ts:448-464`; XHR `.json(page)` `src/service.ts:466-468`; SSR/HTML
  branch `src/service.ts:471-480`.
- `InertiaServiceDeps` `src/service.ts:203-212`.
- `InertiaModuleOptions` `src/types.ts:73-84`; `PageObject` `src/types.ts:4-15`.
- Deps assembled in `src/module.ts:414-423` (the `registerFastifyInertia` factory) —
  NOTE this is the Fastify path; the Express path is wired via
  `src/middleware/express.middleware.js` (find its deps assembly too — see Phase A.4).
- `index.ts:1-68` re-exports; type exports at `index.ts:37-54`.
- Tests live in `packages/core/test/*.spec.ts` (NOT colocated). Harness:
  `test/service.spec.ts` + `test/helpers/fake-request.ts` / `fake-response.ts`
  (`res._captured.{status,body,bodyHtml,headers,ended}`). `pnpm --filter
  @dudousxd/nestjs-inertia test` (vitest 4). `node:diagnostics_channel` is core — NO
  new dependency, peerDeps untouched.

**nestjs-telescope:**
- `Watcher`/`WatcherContext`/`BatchHandle` `packages/core/src/nest/watcher.ts`
  (`record`, `runInBatch`, `beginBatch`, `config`, `moduleRef`).
- `EntryType` map + `RecordInput`/`Entry` `packages/core/src/entry/entry.ts`
  (`batchId`/`traceId`/`spanId` enriched downstream).
- `redactBounded` + `DEFAULT_REDACT_KEYS` + bounds (depth 8, string 8192, array 200,
  nodes 5000, content 16384) `packages/core/src/redaction/redact.ts`.
- Recorder runs `redactBounded(input.content, …)` on every entry and bumps
  `truncatedCount` `packages/core/src/recorder/recorder.ts:474,483`.
- Registrar seeds `[Request, Exception, ...registered, ...clientErrors]` and calls
  `service.setWatchers(types)` using each watcher's `.type`
  `packages/core/src/nest/telescope-watcher-registrar.service.ts:30-48` → flows into
  `/meta.watchers`.
- Core re-exports everything via `packages/core/src/index.ts`
  (`export * from './entry/entry.js'`, `'./nest/watcher.js'`, `'./redaction/redact.js'`,
  `'./config/resolve-config.js'`) — watcher imports from `@dudousxd/nestjs-telescope`.
- Watcher package template: `packages/redis-watcher/` (`src/redis-command.watcher.ts`,
  `src/index.ts`, `src/*.spec.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`).
  Also `packages/events/` (`EventsWatcher` — idempotent `register`/`cleanup`,
  `safeRecord` swallow-all). `cleanup()` is NOT on the `Watcher` interface — it's a
  convention; the registrar only calls `register()`. (Acceptable: matches existing
  watchers; cleanup is exercised by tests.)
- UI (`packages/ui/src`): `react/components/entries-table.tsx` `entryLabel()`
  (the spec's "summaryText" — `if (entry.type === 'event' …)` ladder L20-36, used at
  L94-95 next to `<CacheBadge>`); `react/components/entry-detail.tsx` ladder
  (`entry.type === 'dump' ? <DumpBody/> : …` L34-58) with bodies defined INLINE in the
  same file (`DumpBody` L111, `EventBody` L140, `RedisBody` L200) + `prettyJson()`
  L103; `react/components/cache-badge.tsx` (badge pattern); `react/components/
  entry-types.ts` `ENTRY_TYPES` L21-41 + `visibleEntryTypes()` L103; `react/index.ts`
  barrel. Specs colocated `react/components/*.spec.tsx` (vitest + @testing-library/react,
  `entry-detail.spec.tsx` harness). `packages/ui` scripts: `vitest run --passWithNoTests`.

---

## PHASE A — emit events from `nestjs-inertia` (producer)

**Goal:** `InertiaService.render()` publishes exactly ONE `InertiaRenderDiagnostic` per
response on `nestjs-inertia:render`, gated by `channel.hasSubscribers`, zero-cost when
nobody subscribes, no new dependency. Ships independently (no telescope involved).

### A.1 — New file: the diagnostic contract
**Create** `nestjs-inertia/packages/core/src/diagnostics.ts`:

```ts
import diagnostics_channel from 'node:diagnostics_channel';

/** Channel name — the wire contract with nestjs-telescope's InertiaWatcher.
 *  Versioned by the payload's `v` field, not by name. */
export const INERTIA_DIAG_CHANNEL = 'nestjs-inertia:render';

/** Memoized by Node: same object per name. Read `.hasSubscribers` to gate. */
export const inertiaDiagChannel = diagnostics_channel.channel(INERTIA_DIAG_CHANNEL);

export interface InertiaRenderDiagnostic {
  v: 1;
  component: string;
  url: string;
  method: string;
  isInertia: boolean;
  isPartial: boolean;
  partial: { only: string[]; except: string[]; reset: string[]; resetOnce: string[] };
  props: {
    sharedKeys: string[];
    finalKeys: string[];
    deferred: Record<string, string[]>;
    merge: string[];
    deepMerge: string[];
    matchPropsOn: Record<string, string>;
    optionalKeys: string[];
    onceKeys: string[];
    excludedKeys: string[];
  };
  resolvedProps: unknown;       // FINAL wire props by REFERENCE — never pre-stringified
  assetVersion: string;
  versionMismatch: boolean;
  clientVersion: string | null;
  encryptHistory: boolean;
  clearHistory: boolean;
  statusCode: number;
  pageBytes: number;
  ssr: boolean;
}
```

### A.2 — Thread the opt-out flag
- **Edit** `src/types.ts` — add to `InertiaModuleOptions` (after `flashStore`, ~L83):
  ```ts
  /** Hard-disable diagnostics_channel publishing even when a subscriber exists.
   *  Default true. Set false to guarantee no publish in hardened prod. */
  diagnostics?: boolean;
  ```
- **Edit** `src/service.ts` — add to `InertiaServiceDeps` (~L210):
  ```ts
  diagnostics?: boolean;
  ```
- **Edit** `src/module.ts:414-423` (Fastify deps factory) — add
  `diagnostics: this.options.diagnostics,` alongside `flashStore`.
- **Edit** the Express deps assembly (`src/middleware/express.middleware.js` — locate the
  object literal that builds `InertiaServiceDeps`; it mirrors the Fastify one) — add the
  same `diagnostics: ...` line so BOTH adapters thread it. (Search:
  `grep -rn "flashStore:" src/` to find every deps-assembly site and patch each.)

### A.3 — Classification bookkeeping (guarded) + publish
**Edit** `src/service.ts` `render()`:

1. **Top of `render()`** — capture the gate once:
   ```ts
   const diagOn = this.deps.diagnostics !== false && inertiaDiagChannel.hasSubscribers;
   ```
   (Import `INERTIA_DIAG_CHANNEL`, `inertiaDiagChannel`, type `InertiaRenderDiagnostic`
   from `./diagnostics.js`.)

2. **Hook A — 409 version mismatch** (inside the `if` at L295-302, before `return`):
   publish the minimal variant. `resolvedProps`/arrays empty:
   ```ts
   if (diagOn) {
     inertiaDiagChannel.publish({
       v: 1, component, url: this.req.originalUrl, method: this.req.method,
       isInertia: true, isPartial: false,
       partial: { only: [], except: [], reset: [], resetOnce: [] },
       props: { sharedKeys: [], finalKeys: [], deferred: {}, merge: [], deepMerge: [],
                matchPropsOn: {}, optionalKeys: [], onceKeys: [], excludedKeys: [] },
       resolvedProps: undefined,
       assetVersion: this.deps.assetVersion, versionMismatch: true,
       clientVersion: clientVersion ?? null,
       encryptHistory: false, clearHistory: false,
       statusCode: 409, pageBytes: 0, ssr: false,
     } satisfies InertiaRenderDiagnostic);
   }
   ```

3. **Marker-loop bookkeeping** (L347-440) — declare local arrays before the loop:
   ```ts
   const optionalKeys: string[] = [];
   const onceKeys: string[] = [];
   const excludedKeys: string[] = [];
   const sharedKeys = diagOn ? Object.keys(sharedProps) : [];  // sharedProps @ L321
   ```
   Inside the loop, push ONLY when `diagOn` (cheap, no-op when off):
   - at the `except` drop (L348 `if (exceptKeys.includes(key) …) continue;`):
     `if (diagOn) excludedKeys.push(key);`
   - in the `optional` branch (L355): `if (diagOn) optionalKeys.push(key);`
   - in the `once` branch (L361): `if (diagOn) onceKeys.push(key);`
   - at the partial-filter `continue` (L404-405, key dropped by `keep`):
     `if (diagOn) excludedKeys.push(key);`
   `deferredProps`, `mergeProps`, `deepMergeProps`, `matchPropsOn` are already tracked
   (L342-345) — reuse directly. `finalKeys = Object.keys(wireProps)` (post L446).

4. **Hook B — main path publish** (after `PageObject` assembled, ~L464, before the XHR
   branch at L466). Compute `pageBytes` from the JSON we already need for XHR; for the
   SSR/HTML path compute it only when `diagOn`:
   ```ts
   const isInertia = !!this.req.header('X-Inertia');
   let pageJson: string | null = isInertia ? JSON.stringify(page) : null;
   if (diagOn) {
     if (pageJson === null) pageJson = JSON.stringify(page);  // SSR path, gated only
     inertiaDiagChannel.publish({
       v: 1, component, url: this.req.originalUrl, method: this.req.method,
       isInertia, isPartial,
       partial: { only: keep ?? [], except: exceptKeys, reset: resetKeys, resetOnce: resetOnceKeys },
       props: { sharedKeys, finalKeys: Object.keys(wireProps),
                deferred: deferredProps, merge: mergeProps, deepMerge: deepMergeProps,
                matchPropsOn, optionalKeys, onceKeys, excludedKeys },
       resolvedProps: wireProps,                 // BY REFERENCE — telescope redacts/clips
       assetVersion: this.deps.assetVersion, versionMismatch: false,
       clientVersion: clientVersion ?? null,
       encryptHistory, clearHistory: this.clearHistoryFlag,
       statusCode: 200, pageBytes: Buffer.byteLength(pageJson, 'utf8'),
       ssr: false,  // set true below if SSR produced output
     } satisfies InertiaRenderDiagnostic);
   }
   if (isInertia) {
     this.res.setHeader('X-Inertia','true').setHeader('Vary','X-Inertia').json(page);  // reuse `page`
     return;
   }
   ```
   - Reuse the existing `.json(page)` (don't double-serialize). If you'd rather emit
     `ssr: true` accurately, move the publish to AFTER the SSR `await` in the HTML branch
     (L471-472) for the non-XHR case, OR publish once after computing `ssr` for both
     paths. Simplest correct shape: compute `const ssrModule`/`ssr` first only on the
     HTML branch, so for XHR `ssr:false` is correct; document that `ssr` reflects "this
     render produced SSR output."
   - `clientVersion`, `keep`, `exceptKeys`, `resetKeys`, `resetOnceKeys`, `encryptHistory`
     are all already in scope (L294, L330, L339, L333, L336, L459).

   **Hard constraints honored:** one publish per response; no deep-clone/stringify of
   props; `pageBytes` reuses the XHR serialization (only does extra work when `diagOn`
   on the SSR path); all array-building guarded by `diagOn`.

### A.4 — Exports
**Edit** `src/index.ts`:
```ts
export { INERTIA_DIAG_CHANNEL } from './diagnostics.js';
export type { InertiaRenderDiagnostic } from './diagnostics.js';
```
Add `diagnostics` to the existing `InertiaModuleOptions` type export block (already
re-exported via `export type { … InertiaModuleOptions … } from './types.js'`).

### A.5 — Tests (`packages/core/test/diagnostics.spec.ts`, mirror `service.spec.ts`)
Use `makeService` harness + `node:diagnostics_channel`:
- Subscribe a listener to `nestjs-inertia:render`; `render('Home', …)` → exactly ONE
  event; assert `component`, `url`, `method`, `finalKeys`, `sharedKeys`, `deferred`
  (use `Inertia.defer`), `merge`/`deepMerge`, `optionalKeys`/`onceKeys`,
  `encryptHistory`, `pageBytes > 0`, `statusCode 200`, `versionMismatch false`.
- **409 variant:** force the mismatch (`x-inertia` + stale `x-inertia-version`) → one
  event with `versionMismatch:true`, `statusCode:409`, `resolvedProps` undefined,
  `clientVersion` set.
- **Partial reload:** set `X-Inertia-Partial-Component` + `X-Inertia-Partial-Data` +
  `X-Inertia-Partial-Except`; assert `partial.only`/`partial.except` and
  `props.excludedKeys` match the resolved page.
- **Zero-cost:** with NO subscriber, spy that the classification/publish code is skipped
  — wrap `Object.keys(sharedProps)`-equivalent in the `diagOn` guard and assert via a
  prop factory side-effect counter that nothing diagnostic ran (or assert
  `inertiaDiagChannel.hasSubscribers === false` and no event captured).
- **Opt-out:** `diagnostics: false` in deps + a subscriber present → NO event published.
- Unsubscribe in `afterEach` to keep tests isolated (`channel.unsubscribe(fn)`).

### A.6 — Verify
```bash
pnpm --filter @dudousxd/nestjs-inertia test
pnpm --filter @dudousxd/nestjs-inertia typecheck
pnpm --filter @dudousxd/nestjs-inertia build
pnpm lint   # biome (from repo root)
```
**Done when:** all green; `git grep -n "node:diagnostics_channel" packages/core/src`
shows only `diagnostics.ts`; `package.json` peerDeps unchanged; no `nestjs-telescope`
reference anywhere in inertia.

---

## PHASE B — telescope watcher + storage (consumer)

**Goal:** New `packages/inertia-watcher` package. `InertiaWatcher` subscribes to
`nestjs-inertia:render`, validates structurally, and records one `inertia` entry per
event via `ctx.record(...)`; the Recorder redacts/clips `resolvedProps`. Auto-correlates
into the request batch. With the watcher installed but Phase C not shipped, entries show
under the generic entries view.

### B.1 — Scaffold the package (mirror `packages/redis-watcher`)
**Create** `packages/inertia-watcher/` with:
- `package.json` — copy redis-watcher's, change:
  - `"name": "@dudousxd/nestjs-telescope-inertia-watcher"`
  - `"description": "Inertia.js render watcher for @dudousxd/nestjs-telescope."`
  - `repository.directory: "packages/inertia-watcher"`
  - peerDeps: `{ "@dudousxd/nestjs-telescope": "workspace:^" }` (NO inertia peer — fully
    decoupled; `node:diagnostics_channel` is core).
  - devDeps: `{ "@dudousxd/nestjs-telescope": "workspace:*", "@types/node": "^20.0.0",
    "reflect-metadata": "^0.2.2", "typescript": "^5.4.0", "vitest": "^3.0.0" }`
  - keywords: `["nestjs","telescope","inertia","inertia.js","observability"]`
- `tsconfig.json` — copy redis-watcher's verbatim.
- `vitest.config.ts` — copy redis-watcher's verbatim (`include: ['test/**/*.spec.ts',
  'src/**/*.spec.ts']`).
- `README.md`, `CHANGELOG.md` — minimal stubs (match siblings).

No edits to `pnpm-workspace.yaml` (already globs `packages/*`) or root scripts (turbo
discovers it). After scaffolding run `pnpm install` at repo root to link the workspace
dep.

### B.2 — `src/inertia-content.ts` — content type + structural validator + mapper
```ts
import { EntryType, type RecordInput } from '@dudousxd/nestjs-telescope';

const INERTIA_TYPE = 'inertia';  // or EntryType.Inertia if B.5 added it

export interface InertiaContent {
  component: string; method: string; url: string; statusCode: number;
  isPartial: boolean; versionMismatch: boolean;
  assetVersion: string; clientVersion: string | null;
  encryptHistory: boolean; clearHistory: boolean;
  pageBytes: number; ssr: boolean;
  partial: { only: string[]; except: string[]; reset: string[]; resetOnce: string[] };
  props: {
    sharedKeys: string[]; finalKeys: string[];
    deferred: Record<string, string[]>; merge: string[]; deepMerge: string[];
    matchPropsOn: Record<string, string>;
    optionalKeys: string[]; onceKeys: string[]; excludedKeys: string[];
  };
  resolvedProps: unknown;  // heavy — Recorder's redactBounded clips/masks it
}

// Structural shape duplicated from inertia (NOT imported — decoupling).
export interface InertiaRenderDiagnostic { v: number; component: string; /* …§1.3… */ }

export function isInertiaDiagnostic(msg: unknown): msg is InertiaRenderDiagnostic {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.v === 1
    && typeof m.component === 'string'
    && typeof m.url === 'string'
    && typeof m.method === 'string'
    && typeof m.props === 'object' && m.props !== null
    && typeof m.partial === 'object' && m.partial !== null;
}

export function buildInertiaContent(d: InertiaRenderDiagnostic): RecordInput<InertiaContent> {
  const tags = ['inertia', `inertia:component:${d.component}`];
  if (d.isPartial) tags.push('inertia:partial');
  if (d.versionMismatch) tags.push('inertia:version-mismatch');
  if (Object.keys(d.props.deferred ?? {}).length) tags.push('inertia:deferred');
  if ((d.props.merge?.length ?? 0) || (d.props.deepMerge?.length ?? 0)) tags.push('inertia:merge');
  return {
    type: INERTIA_TYPE,
    familyHash: `inertia:${d.component}`,
    durationMs: null,
    tags,
    content: {
      component: d.component, method: d.method, url: d.url, statusCode: d.statusCode,
      isPartial: d.isPartial, versionMismatch: d.versionMismatch,
      assetVersion: d.assetVersion, clientVersion: d.clientVersion,
      encryptHistory: d.encryptHistory, clearHistory: d.clearHistory,
      pageBytes: d.pageBytes, ssr: d.ssr, partial: d.partial,
      props: d.props,
      resolvedProps: d.resolvedProps,   // passed by reference; Recorder redacts
    },
  };
}
```
**Do NOT** stringify/clone `resolvedProps` here — the Recorder's `redactBounded` must
traverse the live object to clip + mask it (spec §2.2.2).

### B.3 — `src/inertia.watcher.ts` — the DC subscriber (mirror EventsWatcher shape)
```ts
import diagnostics_channel from 'node:diagnostics_channel';
import type { Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';
import { buildInertiaContent, isInertiaDiagnostic } from './inertia-content.js';

const INERTIA_CHANNEL = 'nestjs-inertia:render';  // hardcoded contract (no inertia import)

export class InertiaWatcher implements Watcher {
  readonly type = 'inertia';
  private registered = false;
  private onMessage: ((msg: unknown) => void) | null = null;

  register(ctx: WatcherContext): void {
    if (this.registered) return;
    this.registered = true;
    const ch = diagnostics_channel.channel(INERTIA_CHANNEL);
    this.onMessage = (msg) => this.safeRecord(ctx, msg);
    ch.subscribe(this.onMessage);   // flips inertia's hasSubscribers -> true
  }

  cleanup(): void {
    if (this.onMessage) {
      diagnostics_channel.channel(INERTIA_CHANNEL).unsubscribe(this.onMessage);
      this.onMessage = null;
    }
    this.registered = false;
  }

  private safeRecord(ctx: WatcherContext, msg: unknown): void {
    try {
      if (!isInertiaDiagnostic(msg)) return;     // drops wrong-v / malformed, never throws
      ctx.record(buildInertiaContent(msg));      // synchronous → lands in request ALS batch
    } catch { /* swallow — telescope must never break a render */ }
  }
}
```

### B.4 — `src/index.ts`
```ts
export { InertiaWatcher } from './inertia.watcher.js';
export type { InertiaContent } from './inertia-content.js';
export { buildInertiaContent, isInertiaDiagnostic } from './inertia-content.js';
```

### B.5 — (Optional, nice-to-have) typed constant in core
**Edit** `packages/core/src/entry/entry.ts` `EntryType` map — add `Inertia: 'inertia',`.
Not required for registration (the registrar uses `watcher.type` strings), but gives a
typed constant. If added, use `EntryType.Inertia` in B.2/B.3 instead of the literal.
Keep this as a separate small commit so Phase B's watcher package stays the focus.

### B.6 — Tests (`packages/inertia-watcher/src/inertia.watcher.spec.ts`,
mirror `redis-command.watcher.spec.ts` + `events.watcher.spec.ts`)
Use the same `makeHarness()` (fake `WatcherContext` with `record` pushing into an array,
`resolveConfig({})`, stub `moduleRef`). `node:diagnostics_channel` is real:
- `type === 'inertia'`.
- `register(ctx)` subscribes → channel `.hasSubscribers === true`; publishing a valid
  diagnostic calls `ctx.record` once with mapped `content`/`tags`/`familyHash`
  (`inertia:<component>`, tags include `inertia:partial`/`:version-mismatch`/`:deferred`
  /`:merge` as appropriate).
- `cleanup()` unsubscribes → `.hasSubscribers === false`.
- **Idempotent register:** double `register` subscribes once (one `record` per publish).
- **Malformed / wrong-`v`:** publish `{ v: 99 }`, `null`, `{}` → no `record`, no throw.
- **`record` throws** (`recordThrows: true` harness) → `safeRecord` swallows, no throw.
- **Redaction integration** (use the real `Recorder` or assert intent): a `resolvedProps`
  containing `{ password: 'x' }` and an oversized array comes out `[REDACTED]` / truncated
  with `truncatedCount` bumped. (Lighter option: unit-test `buildInertiaContent` passes
  `resolvedProps` by reference and a separate test drives `redactBounded` over it.)
- **Correlation:** wrap the publish in `ctx.runInBatch('http', …)` (or assert the
  synchronous-publish property) so the recorded entry's `batchId` matches the surrounding
  batch.

### B.7 — Verify
```bash
pnpm install   # link the new workspace package
pnpm --filter @dudousxd/nestjs-telescope-inertia-watcher test
pnpm --filter @dudousxd/nestjs-telescope-inertia-watcher typecheck
pnpm --filter @dudousxd/nestjs-telescope-inertia-watcher build
# end-to-end sanity (optional): in an example app,
#   TelescopeModule.forRoot({ watchers: [ new InertiaWatcher() ] })
# then hit an inertia route and confirm an `inertia` entry appears in /meta.watchers + entries.
```
**Done when:** package green; `setWatchers` surfaces `'inertia'` in `/meta.watchers` when
installed; no inertia import anywhere in the package (`git grep -n "nestjs-inertia"
packages/inertia-watcher/src` → empty).

---

## PHASE C — the UI panel (`packages/ui`)

**Goal:** Rich Inertia detail panel + list summary + nav tab. Rides the existing generic
entries infra. Self-hides when `'inertia'` isn't in `/meta.watchers`.

### C.1 — List summary
**Edit** `packages/ui/src/react/components/entries-table.tsx` `entryLabel()` (the spec's
"summaryText", L20-36 ladder). Add before the generic fallthrough:
```ts
if (entry.type === 'inertia' && typeof record.component === 'string') {
  const method = typeof record.method === 'string' ? record.method : '';
  const partial = record.isPartial === true ? ' (partial)' : '';
  return `${method} → ${record.component}${partial}`.trim();
}
```

### C.2 — `InertiaBadge` (mirror `cache-badge.tsx`)
**Create** `packages/ui/src/react/components/inertia-badge.tsx`: a pure
`inertiaBadges(content): {label,className}[]` returning chips for `409`
(red, when `versionMismatch`), `partial`, `deferred` (when `deferred` non-empty), and a
human `pageBytes` chip. `InertiaBadge` renders them; returns `null` for non-inertia
content. Reuse the `PILL_BASE` token style from `cache-badge.tsx`.

### C.3 — `InertiaBody` (new file, NOT inline — spec §5.3)
**Create** `packages/ui/src/react/components/inertia-body.tsx` exporting `InertiaBody`
(+ internal `PartialReloadPanel`, `DeferredGroups`, `PropClassChips`, `ResolvedPropsTree`).
Read all fields defensively (content may be redacted/clipped). Sections (spec §5.2):
1. Header: `method url → component`, status badge (200/409), `partial` badge, asset
   version chip. If `versionMismatch`: red callout "Version mismatch: client
   `<clientVersion>` ≠ server `<assetVersion>` → 409 forced full reload."
2. Partial-reload panel (only when `isPartial`): two columns Kept (`partial.only`) /
   Excluded (`partial.except` ∪ `props.excludedKeys`), plus `reset`/`resetOnce` chips.
3. Prop classification chips: Shared / Final / Optional / Once / Merge / Deep-merge with
   `matchPropsOn` annotations.
4. Deferred groups: `props.deferred` as `group → [dotPaths]`.
5. Resolved props tree: reuse `prettyJson(...)` in a `<pre className="overflow-auto
   rounded bg-zinc-900 p-3 text-xs text-zinc-300">` exactly like `DumpBody`/`EventBody`.
   Recorder truncation markers (`[Truncated: size]`, `…[truncated]`, `[REDACTED]`) show
   verbatim.
6. History flags: `encryptHistory` / `clearHistory` chips.
7. Response: `pageBytes` (human-readable) + `ssr` yes/no.

`prettyJson` is currently a private fn in `entry-detail.tsx`. Either export it from there
and import into `inertia-body.tsx`, or copy the 6-line helper locally (it's trivial and
duplicated-style is fine). Prefer exporting it to avoid drift.

### C.4 — Wire the detail dispatch
**Edit** `packages/ui/src/react/components/entry-detail.tsx`:
- Import `InertiaBody` (from `./inertia-body.js`) and optionally `InertiaBadge`.
- Add a ladder branch (alongside L42-43 `redis`):
  ```tsx
  ) : entry.type === 'inertia' ? (
    <InertiaBody content={entry.content} />
  ```
- (Optional) in the header at L24, add
  `{entry.type === 'inertia' ? <InertiaBadge content={entry.content} /> : null}`.

### C.5 — Nav + barrel
- **Edit** `packages/ui/src/react/components/entry-types.ts` `ENTRY_TYPES` (L21-41): add
  `{ id: 'inertia', label: 'Inertia', dot: 'bg-cyan-400' }`. It self-hides via
  `visibleEntryTypes` because `/meta.watchers` omits `'inertia'` unless the watcher is
  installed (Phase B). No route change needed — `/entries/:type` already handles it.
- **Edit** `packages/ui/src/react/index.ts` — add
  `export * from './components/inertia-body.js';` and
  `export * from './components/inertia-badge.js';`.

### C.6 — Tests (mirror `entry-detail.spec.tsx` + `cache-badge.spec.tsx` +
`entries-table.spec.tsx`)
- `inertia-body.spec.tsx`: renders component header, partial Kept/Excluded columns,
  deferred groups, version-mismatch red callout, resolved-props tree, history flag chips.
- `inertia-badge.spec.tsx`: `409`/`partial`/`deferred`/bytes chips from content; `null`
  for non-inertia.
- `entries-table.spec.tsx`: `entryLabel` of an inertia entry → `METHOD → Component
  (partial)`.
- (Optional) `entry-types`/nav test: `'inertia'` visible only when `meta.watchers`
  includes it (extend the existing `visibleEntryTypes` test).

### C.7 — Verify
```bash
pnpm --filter @dudousxd/nestjs-telescope-ui test       # vitest + @testing-library/react
pnpm --filter @dudousxd/nestjs-telescope-ui typecheck
pnpm --filter @dudousxd/nestjs-telescope-ui build      # vite + tsc lib/server
pnpm lint
```
(Confirm the exact UI package name with `node -e` on `packages/ui/package.json`.)
**Done when:** all green; nav tab appears only with the watcher installed; detail panel
renders all sections; version-mismatch entry shows the red callout.

---

## Risks & mitigations

1. **Payload version coupling (cross-repo contract drift).** The `v: 1` field + the
   channel string are the ONLY contract. Mitigation: telescope validates `v === 1`
   structurally and DROPS anything else (B.2). When inertia bumps to `v: 2`, the old
   watcher silently ignores new events until upgraded — fail-safe, never throws. Keep the
   structural type comment in BOTH files pointing at spec §1.3 as the source of truth.

2. **Large `resolvedProps` (GC/perf).** Producer passes by reference and never
   stringifies (A.3); consumer relies on the Recorder's `redactBounded` (depth 8, content
   16 KB, nodes 5 000) — the same incident-guard `req.user` mega-graphs already get. Risk
   if a future refactor pre-stringifies props on either side → defeats the bound. Mitigate
   with an explicit test asserting `resolvedProps` is passed by reference and that a
   `password` key / oversized tree comes out masked/clipped (A.5 reference test idea +
   B.6 redaction test). Hosts can additionally `sampling` the `inertia` type.

3. **Prod opt-out / privacy.** Three independent default-safe gates: (a) no
   `InertiaWatcher` installed → `hasSubscribers` false → inertia publishes nothing;
   (b) per-type `sampling` throttles `inertia` in prod; (c) inertia `diagnostics: false`
   hard-kills publishing even with a subscriber. Secret keys auto-masked via
   `DEFAULT_REDACT_KEYS`. Document the `diagnostics: false` flag in the inertia README.

4. **`pageBytes` double-serialization.** Reuse the XHR `.json(page)` serialization;
   only `JSON.stringify(page)` again on the SSR/HTML path AND only inside the `diagOn`
   guard. Risk: if someone moves the publish after `.json()` has consumed/streamed the
   page. Mitigate by serializing `pageJson` once before the XHR `.json(page)` call and
   passing `page` (not the string) to `.json`.

5. **`ssr` accuracy.** The simplest publish point (before the XHR branch) can't know SSR
   output yet. Either accept `ssr` = "produced SSR output this render" computed on the
   HTML branch (publish once per path), or document the semantic. Keep it one publish per
   response either way (spec §1.1).

6. **`cleanup()` not on the `Watcher` interface.** The registrar only calls `register()`;
   `cleanup()` is a convention (matches EventsWatcher/RedisWatcher) exercised by tests
   and any future teardown hook. Acceptable — do not invent a new lifecycle.

7. **Express vs Fastify deps assembly.** `diagnostics` must be threaded in BOTH adapter
   deps factories (A.2). Grep `flashStore:` to find every site; a missed site means
   `diagnostics` is `undefined` there (defaults to enabled) — safe but inconsistent with
   the opt-out. Test both adapters if feasible.

8. **Workspace linking.** New package needs `pnpm install` before its workspace dep
   resolves; CI/turbo pick it up via the `packages/*` glob automatically (no
   `pnpm-workspace.yaml` edit). Add a changeset for each repo's published packages.

---

## Suggested commit / PR sequencing

- **PR 1 (inertia, Phase A):** `diagnostics.ts`, service/types/module/express edits,
  exports, `diagnostics.spec.ts`, changeset. Ships safely — no-op when unwatched.
- **PR 2 (telescope, Phase B):** `packages/inertia-watcher`, optional `EntryType.Inertia`,
  tests, changeset. Data appears under generic entries.
- **PR 3 (telescope, Phase C):** `inertia-body.tsx`, `inertia-badge.tsx`, table/detail/
  nav/barrel edits, UI tests. Rich panel + nav tab.
