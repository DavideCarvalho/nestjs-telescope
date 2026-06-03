# OTel Span Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp captured Telescope entries with the active OpenTelemetry span's `traceId`/`spanId` and surface a clickable trace link in the dashboard.

**Architecture:** A new optional `TraceContextProvider` SPI in core; the Recorder reads it at enrich time and writes two new first-class `Entry` fields; storages persist them additively (self-healing, no migrations); a new `@dudousxd/nestjs-telescope-otel` package implements the SPI over `@opentelemetry/api`; the UI entry-detail shows a Trace row.

**Tech Stack:** TypeScript, NestJS 11, pnpm/turbo monorepo, vitest, MikroORM, better-sqlite3, ioredis, React (-ui), `@opentelemetry/api`.

**Spec:** `docs/superpowers/specs/2026-06-03-otel-span-linking-design.md` (read for rationale; this plan is self-contained).

**Conventions:** No `as`/`unknown`/`never`/`any` in source. Fixed dep versions (no `^`/`~`). Function declarations over arrows where it's a named top-level. Commit per task, no Co-Authored-By. After each task: `pnpm -w build && pnpm -w test && pnpm -w lint` for the touched packages (or whole-repo at the end).

---

### Task 1: Core — `TraceContextProvider` SPI + `Entry` trace fields

**Files:**
- Create: `packages/core/src/trace/trace-context-provider.ts`
- Modify: `packages/core/src/entry/entry.ts` (add fields to `Entry`)
- Modify: `packages/core/src/index.ts` (export the SPI)
- Test: `packages/core/src/trace/trace-context-provider.spec.ts`

- [ ] **Step 1: Write the SPI file**

```ts
// packages/core/src/trace/trace-context-provider.ts

/** A snapshot of the currently-active distributed-trace position. */
export interface TraceContext {
  traceId: string;
  spanId: string;
}

/**
 * Resolves the ambient trace context at record time. Optional integration point
 * wired via TelescopeModuleOptions.traceContext. Implementations MUST be cheap
 * (called on every recorded entry) and MUST NOT throw — return null when no span
 * is active or the tracer is unavailable.
 */
export interface TraceContextProvider {
  current(): TraceContext | null;
}
```

- [ ] **Step 2: Add fields to `Entry`** in `packages/core/src/entry/entry.ts`, after `instanceId`:

```ts
  instanceId: string;
  /** Active OTel trace id at record time, or null when no span / no provider. */
  traceId: string | null;
  /** Active OTel span id at record time, or null when no span / no provider. */
  spanId: string | null;
  createdAt: Date;
```

- [ ] **Step 3: Export from index** — add to `packages/core/src/index.ts` near the entry exports:

```ts
export * from './trace/trace-context-provider.js';
```

- [ ] **Step 4: Write a trivial type/contract test** `trace-context-provider.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { TraceContext, TraceContextProvider } from './trace-context-provider.js';

describe('TraceContextProvider', () => {
  it('a provider can return a context or null', () => {
    const ctx: TraceContext = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    const provider: TraceContextProvider = { current: () => ctx };
    const empty: TraceContextProvider = { current: () => null };
    expect(provider.current()).toEqual(ctx);
    expect(empty.current()).toBeNull();
  });
});
```

- [ ] **Step 5: Fix all `Entry` literals across core** — any object literal typed as `Entry` (or returned where `Entry` is expected) now needs `traceId`/`spanId`. Search and fix:

Run: `cd packages/core && grep -rln "instanceId:" src` then add `traceId: null, spanId: null,` to each `Entry` literal (test factories, recorder.spec, sqlite/in-memory specs, pulse/metrics fixtures). The Recorder's `enrich()` literal is handled in Task 2 — leave it for now (it will fail to compile until Task 2; that's expected and the next task fixes it). If you prefer green-between-tasks, add `traceId: null, spanId: null` to the enrich() literal here too as a placeholder.

- [ ] **Step 6: Build + test core**

Run: `pnpm --filter @dudousxd/nestjs-telescope build && pnpm --filter @dudousxd/nestjs-telescope test`
Expected: PASS (add the enrich() placeholder fields if the build complains about the Recorder literal).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(core): add TraceContextProvider SPI and Entry trace fields"
```

---

### Task 2: Core — Recorder enrichment

**Files:**
- Modify: `packages/core/src/recorder/recorder.ts` (RecorderOptions + enrich)
- Test: `packages/core/src/recorder/recorder.spec.ts`

- [ ] **Step 1: Write failing tests** in `recorder.spec.ts` — add a describe block:

```ts
describe('trace context enrichment', () => {
  function makeRecorder(traceContext?: TraceContextProvider) {
    // reuse the spec's existing harness/factory for storage+context+options;
    // pass traceContext through the Recorder options.
  }

  it('stamps traceId/spanId when a context is active', async () => {
    const recorder = makeRecorder({
      current: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
    });
    recorder.record({ type: 'request', content: {} });
    await recorder.flush();
    const stored = /* read the single stored entry from the test storage */;
    expect(stored.traceId).toBe('a'.repeat(32));
    expect(stored.spanId).toBe('b'.repeat(16));
  });

  it('stamps null when no provider is configured', async () => {
    const recorder = makeRecorder(undefined);
    recorder.record({ type: 'request', content: {} });
    await recorder.flush();
    const stored = /* … */;
    expect(stored.traceId).toBeNull();
    expect(stored.spanId).toBeNull();
  });

  it('stamps null when the provider returns null', async () => {
    const recorder = makeRecorder({ current: () => null });
    recorder.record({ type: 'request', content: {} });
    await recorder.flush();
    const stored = /* … */;
    expect(stored.traceId).toBeNull();
  });

  it('records the entry with null ids when the provider throws', async () => {
    const recorder = makeRecorder({
      current: () => {
        throw new Error('boom');
      },
    });
    recorder.record({ type: 'request', content: {} });
    await recorder.flush();
    const stored = /* … */;
    // record() swallows into a record-error drop; with the defensive read below
    // (try/catch in enrich) the entry is still stored with null ids.
    expect(stored.traceId).toBeNull();
  });
});
```

Match the existing spec's actual storage/harness API when filling the `/* … */` reads (the file already constructs a Recorder with an in-memory or fake storage; reuse it).

- [ ] **Step 2: Run tests to confirm they fail**

Run: `pnpm --filter @dudousxd/nestjs-telescope test recorder`
Expected: FAIL (traceContext not yet an option).

- [ ] **Step 3: Add the option + enrichment** in `recorder.ts`:

Add to `RecorderOptions`:

```ts
  /** Optional ambient trace-context source; read once per recorded entry. */
  traceContext?: TraceContextProvider;
```

(import `TraceContextProvider` from `../trace/trace-context-provider.js`.)

In `enrich()`, before building `base`, read defensively (the "throws" test relies on this — the provider contract says it must not throw, but we guard anyway):

```ts
let trace: TraceContext | null = null;
try {
  trace = this.options.traceContext?.current() ?? null;
} catch {
  trace = null;
}
```

Add to the `base` literal:

```ts
  instanceId: this.options.instanceId,
  traceId: trace?.traceId ?? null,
  spanId: trace?.spanId ?? null,
  createdAt: input.startedAt ?? new Date(this.now()),
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `pnpm --filter @dudousxd/nestjs-telescope test recorder`
Expected: PASS (4/4 new).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): Recorder stamps active trace context onto entries"
```

---

### Task 3: Core — options, config passthrough, service + meta wiring

**Files:**
- Modify: `packages/core/src/config/options.ts` (`TelescopeCoreOptions` + `ResolvedCoreConfig`)
- Modify: `packages/core/src/config/resolve-config.ts` (passthrough)
- Modify: `packages/core/src/nest/telescope.options.ts` (re-export shape inherits; nothing if it extends core options)
- Modify: `packages/core/src/nest/telescope.service.ts` (pass `traceContext` to Recorder; `traceLink` into meta)
- Modify: `packages/core/src/nest/telescope.controller.ts` (meta already delegates to service — no change unless needed)
- Test: `packages/core/src/config/resolve-config.spec.ts`, `packages/core/src/nest/telescope.service.spec.ts`

- [ ] **Step 1: Failing tests**

In `resolve-config.spec.ts`:

```ts
it('passes traceLink and traceContext through unchanged', () => {
  const traceContext = { current: () => null };
  const resolved = resolveConfig({ traceLink: 'https://t/{traceId}', traceContext });
  expect(resolved.traceLink).toBe('https://t/{traceId}');
  expect(resolved.traceContext).toBe(traceContext);
});

it('defaults traceLink/traceContext to undefined', () => {
  const resolved = resolveConfig({});
  expect(resolved.traceLink).toBeUndefined();
  expect(resolved.traceContext).toBeUndefined();
});
```

In `telescope.service.spec.ts`, add to the existing `getMeta` test (or a new one):

```ts
it('getMeta exposes traceLink (null when unset)', async () => {
  // construct service with config.traceLink set → expect meta.traceLink === that
  // and with it unset → expect meta.traceLink === null
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm --filter @dudousxd/nestjs-telescope test resolve-config telescope.service`
Expected: FAIL.

- [ ] **Step 3: Implement**

`options.ts` — add to `TelescopeCoreOptions`:

```ts
  /** Optional ambient trace-context source (e.g. OtelTraceContextProvider). */
  traceContext?: TraceContextProvider;
  /** UI trace-link URL template with {traceId}/{spanId} placeholders. */
  traceLink?: string;
```

(import `TraceContextProvider` from `../trace/trace-context-provider.js`.)

Add to `ResolvedCoreConfig`:

```ts
  traceContext?: TraceContextProvider;
  traceLink?: string;
```

`resolve-config.ts` — in the returned object, pass through (only set keys when present to keep optionals clean, OR set verbatim — match the file's existing style for optional passthrough like `filter`):

```ts
  ...(options.traceContext ? { traceContext: options.traceContext } : {}),
  ...(options.traceLink ? { traceLink: options.traceLink } : {}),
```

`telescope.service.ts` — in the `new Recorder({...})` call, add (spread-guarded like `filter`):

```ts
  ...(config.traceContext ? { traceContext: config.traceContext } : {}),
```

Extend `TelescopeMeta` interface with `traceLink: string | null;` and in `getMeta()`:

```ts
  return {
    enabled: ...,
    droppedCount: ...,
    watchers: [...this.watcherTypes],
    traceLink: this.config.traceLink ?? null,
  };
```

- [ ] **Step 4: Run to confirm pass**

Run: `pnpm --filter @dudousxd/nestjs-telescope test resolve-config telescope.service`
Expected: PASS.

- [ ] **Step 5: Build core**

Run: `pnpm --filter @dudousxd/nestjs-telescope build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(core): wire traceContext + traceLink through config, service, and meta"
```

---

### Task 4: sqlite storage — persist trace columns + boot add-column guard

**Files:**
- Modify: `packages/core/src/storage/sqlite-storage-provider.ts`
- Test: `packages/core/src/storage/sqlite-storage-provider.spec.ts`

- [ ] **Step 1: Failing tests** in the sqlite spec:

```ts
it('round-trips traceId/spanId (and null)', async () => {
  const provider = new SqliteStorageProvider(':memory:');
  await provider.init?.();
  await provider.store([
    entry({ id: '1', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
    entry({ id: '2', traceId: null, spanId: null }),
  ]);
  const a = await provider.find('1');
  const b = await provider.find('2');
  expect(a?.traceId).toBe('a'.repeat(32));
  expect(a?.spanId).toBe('b'.repeat(16));
  expect(b?.traceId).toBeNull();
});

it('adds trace columns to a pre-existing column-less table on init', async () => {
  // create a raw better-sqlite3 db with the OLD DDL (no trace_id/span_id),
  // point a SqliteStorageProvider at it, call init(), then store+find an entry
  // with traceId set and assert it persisted (proves the alter-table guard ran).
});
```

(Use the spec's existing `entry()` factory; ensure it now defaults `traceId/spanId` to null — done in Task 1.)

- [ ] **Step 2: Confirm fail** — Run: `pnpm --filter @dudousxd/nestjs-telescope test sqlite` → FAIL.

- [ ] **Step 3: Implement**

In the `create table if not exists` DDL add two columns (nullable text):

```sql
        instance_id text not null,
        trace_id text,
        span_id text,
        created_at ...
```

Add `trace_id`/`span_id` to the `Row` type, the prepared INSERT column list + `@trace_id, @span_id` values, `toRow` (`trace_id: entry.traceId, span_id: entry.spanId`), and `fromRow` (`traceId: row.trace_id ?? null, spanId: row.span_id ?? null`).

Add an idempotent boot migration in `init()` (after the create-table) — sqlite has no `add column if not exists`, so attempt and swallow the duplicate-column error:

```ts
private ensureColumn(name: string, ddl: string): void {
  try {
    this.db.exec(`alter table telescope_entries add column ${ddl}`);
  } catch (error) {
    // SQLITE_ERROR "duplicate column name" — already present. Re-throw anything else.
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('duplicate column')) throw error;
  }
}
```

Call `this.ensureColumn('trace_id', 'trace_id text')` and `this.ensureColumn('span_id', 'span_id text')` in `init()`. (For a freshly-created table the columns already exist from the DDL, so both no-op via the swallow — that's fine and exactly the additive contract.)

- [ ] **Step 4: Confirm pass** — Run: `pnpm --filter @dudousxd/nestjs-telescope test sqlite` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): sqlite persists trace_id/span_id with additive boot guard"
```

---

### Task 5: mikro-orm storage — trace fields + self-heal columns

**Files:**
- Modify: `packages/mikro-orm/src/telescope-entry.entity.ts`
- Modify: `packages/mikro-orm/src/mikro-orm-storage.provider.ts` (toRow/fromRow mapping)
- Test: `packages/mikro-orm/src/mikro-orm-storage.provider.integration.spec.ts`

- [ ] **Step 1: Failing test** — add to the integration spec:

```ts
it('round-trips traceId/spanId through MySQL/sqlite schema', async () => {
  await provider.store([
    makeEntry({ id: '1', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
    makeEntry({ id: '2', traceId: null, spanId: null }),
  ]);
  const found = await provider.find('1');
  expect(found?.traceId).toBe('a'.repeat(32));
  expect(found?.spanId).toBe('b'.repeat(16));
  const found2 = await provider.find('2');
  expect(found2?.traceId).toBeNull();
});
```

(If feasible in the harness, add a self-heal additive assertion: create the table WITHOUT the trace columns, then `init()` and confirm `schema.update({safe})` added them — mirror the existing `duration_ms` additive guard test.)

- [ ] **Step 2: Confirm fail** — Run: `pnpm --filter @dudousxd/nestjs-telescope-mikro-orm test` → FAIL.

- [ ] **Step 3: Implement**

In `telescope-entry.entity.ts` (EntitySchema properties) add, near `instanceId`:

```ts
    traceId: { type: 'string', nullable: true },
    spanId: { type: 'string', nullable: true },
```

(Confirm the column-name strategy — if the schema uses explicit `fieldName`, set `fieldName: 'trace_id'` / `'span_id'` to match the snake_case convention used by the other columns.)

In the provider's Entry↔row mapping (the methods that build the persisted object and reconstruct the `Entry`), carry `traceId`/`spanId` through (default to `null`).

- [ ] **Step 4: Confirm pass** — Run: `pnpm --filter @dudousxd/nestjs-telescope-mikro-orm test` → PASS (self-heal `update({safe})` adds the columns automatically at init; no migration).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(mikro-orm): persist traceId/spanId, self-healed at boot"
```

---

### Task 6: redis + in-memory storage — round-trip coverage

**Files:**
- Test: `packages/redis/src/redis-storage-provider.spec.ts` (or integration spec)
- Test: `packages/core/src/storage/in-memory-storage-provider.spec.ts`

- [ ] **Step 1: Add round-trip tests** asserting `traceId`/`spanId` survive store→find for both providers (set + null). No production code change expected (redis `JSON.stringify(entry)` and in-memory store-the-object both carry the fields for free). If a test reveals the redis read path reconstructs fields explicitly (dropping the new ones), add `traceId`/`spanId` to that reconstruction.

```ts
it('round-trips traceId/spanId', async () => {
  await provider.store([entry({ id: '1', traceId: 't', spanId: 's' })]);
  const found = await provider.find('1');
  expect(found?.traceId).toBe('t');
  expect(found?.spanId).toBe('s');
});
```

- [ ] **Step 2: Run** — Run: `pnpm --filter @dudousxd/nestjs-telescope-redis test && pnpm --filter @dudousxd/nestjs-telescope test in-memory`
Expected: PASS (add fields to the redis deserialize path only if a test fails).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(storage): cover trace field round-trip for redis and in-memory"
```

---

### Task 7: New package `@dudousxd/nestjs-telescope-otel`

**Files:**
- Create package skeleton under `packages/otel/` mirroring `packages/mail/` (smallest adapter): `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `README.md`, `src/index.ts`, `src/otel-trace-context-provider.ts`, `src/otel-trace-context-provider.spec.ts`.
- Create: `.changeset/otel-span-linking.md`

> Copy an existing small package's config files verbatim and adjust `name`/paths. Match the repo's tsup/vitest/biome setup. Do NOT invent new tooling.

- [ ] **Step 1: Scaffold `package.json`** (fixed versions; `@opentelemetry/api` as peer + dev):

```jsonc
{
  "name": "@dudousxd/nestjs-telescope-otel",
  "version": "0.0.0",
  "type": "module",
  // …match exports/main/module/types + scripts (build/test/lint) from packages/mail/package.json…
  "peerDependencies": {
    "@dudousxd/nestjs-telescope": "workspace:*",
    "@opentelemetry/api": ">=1.0.0"
  },
  "peerDependenciesMeta": { "@opentelemetry/api": { "optional": true } },
  "devDependencies": {
    "@dudousxd/nestjs-telescope": "workspace:*",
    "@opentelemetry/api": "<pin the version already used elsewhere or latest 1.x>"
    // + the same build/test/lint devDeps the other packages pin
  }
}
```

- [ ] **Step 2: Write failing tests** `otel-trace-context-provider.spec.ts`:

```ts
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { OtelTraceContextProvider } from './otel-trace-context-provider.js';

function withSpan<T>(traceId: string, spanId: string, fn: () => T): T {
  const spanContext = { traceId, spanId, traceFlags: 1, isRemote: false };
  const ctx = trace.setSpanContext(ROOT_CONTEXT, spanContext);
  return context.with(ctx, fn);
}

describe('OtelTraceContextProvider', () => {
  const provider = new OtelTraceContextProvider();

  it('returns the active span ids', () => {
    withSpan('a'.repeat(32), 'b'.repeat(16), () => {
      expect(provider.current()).toEqual({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) });
    });
  });

  it('returns null when no span is active', () => {
    expect(provider.current()).toBeNull();
  });

  it('returns null for an invalid (all-zero) span context', () => {
    withSpan('0'.repeat(32), '0'.repeat(16), () => {
      expect(provider.current()).toBeNull();
    });
  });
});
```

- [ ] **Step 3: Confirm fail** — Run: `pnpm --filter @dudousxd/nestjs-telescope-otel test` → FAIL (module missing).

- [ ] **Step 4: Implement** `otel-trace-context-provider.ts`:

```ts
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { TraceContext, TraceContextProvider } from '@dudousxd/nestjs-telescope';

/**
 * Reads the active OpenTelemetry span via @opentelemetry/api and exposes its
 * trace/span ids to Telescope. Wire it as `traceContext` in TelescopeModule
 * options. Degrades to null (no link) when no span is active or the API is
 * absent — never throws.
 */
export class OtelTraceContextProvider implements TraceContextProvider {
  current(): TraceContext | null {
    try {
      const span = trace.getActiveSpan();
      if (!span) return null;
      const spanContext = span.spanContext();
      if (!spanContext || !isSpanContextValid(spanContext)) return null;
      return { traceId: spanContext.traceId, spanId: spanContext.spanId };
    } catch {
      return null;
    }
  }
}
```

`src/index.ts`:

```ts
export * from './otel-trace-context-provider.js';
```

- [ ] **Step 5: Confirm pass** — Run: `pnpm --filter @dudousxd/nestjs-telescope-otel test` → PASS (3/3).

- [ ] **Step 6: README** — short usage doc mirroring `packages/mail/README.md` structure: install, wire `traceContext: new OtelTraceContextProvider()` + `traceLink` template, note the optional peer dep and the read-only (no export) scope.

- [ ] **Step 7: Changeset** `.changeset/otel-span-linking.md` — `@dudousxd/nestjs-telescope-otel` minor (new), `@dudousxd/nestjs-telescope` minor (SPI + Entry fields + meta.traceLink), `@dudousxd/nestjs-telescope-mikro-orm` minor (trace columns). Summarize the feature.

- [ ] **Step 8: Build + register in workspace** (ensure root tsconfig/turbo picks up the new package; it should via the `packages/*` glob).

Run: `pnpm install && pnpm --filter @dudousxd/nestjs-telescope-otel build`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(otel): add @dudousxd/nestjs-telescope-otel TraceContextProvider"
```

---

### Task 8: UI — Trace row in entry detail + meta traceLink

**Files:**
- Modify: `packages/ui/src/react/components/entry-detail.tsx`
- Modify: the UI's meta/client type (wherever `TelescopeMeta` is mirrored client-side and fetched) to include `traceLink: string | null`.
- Test: the existing entry-detail test file (or create one alongside) if the -ui package has component tests; otherwise a render/unit test for the link-template substitution helper.

- [ ] **Step 1: Add a pure helper + test** — a `buildTraceHref(template, traceId, spanId)` that substitutes `{traceId}`/`{spanId}`. Test: substitutes both; returns null when template is null/empty.

```ts
export function buildTraceHref(
  template: string | null,
  traceId: string,
  spanId: string,
): string | null {
  if (!template) return null;
  return template.replaceAll('{traceId}', traceId).replaceAll('{spanId}', spanId);
}
```

- [ ] **Step 2: Render the Trace row** in `entry-detail.tsx`, shown only when `entry.traceId` is present:
  - `traceId` (monospace) + `spanId` (secondary).
  - When `meta.traceLink` is set → render as an external anchor (`buildTraceHref`, `target="_blank" rel="noreferrer"`).
  - Else → plain monospace text with the existing copy affordance used by other detail rows.
  - Match the existing detail-row markup/styling (don't introduce a new pattern).

- [ ] **Step 3: Thread `traceLink`** from the meta fetch into the detail component (the UI already fetches `/telescope/api/meta`; add `traceLink` to its client type and pass it down, or read it from the meta query where the detail renders).

- [ ] **Step 4: Build + test -ui**

Run: `pnpm --filter @dudousxd/nestjs-telescope-ui build && pnpm --filter @dudousxd/nestjs-telescope-ui test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(ui): show trace id/span id with clickable trace link in entry detail"
```

---

### Task 9: Whole-repo green + final review

- [ ] **Step 1: Whole-repo build/test/lint**

Run: `pnpm -w build && pnpm -w test && pnpm -w lint`
Expected: all packages build (13 incl. new otel), all tests pass, lint clean.

- [ ] **Step 2: Verify no `as`/`unknown`/`never`/`any`** were introduced in source (tests may use minimal casts for fakes only if unavoidable — prefer typed fakes).

Run: `git diff master --stat` and skim the source diffs.

- [ ] **Step 3: Final commit if anything pending** (changesets, lockfile).

```bash
git add -A && git commit -m "chore(otel): changesets + lockfile for span linking" || true
```

---

## Dogfood (after lib green — separate, not part of subagent loop)

Repack cache-busted tarballs (`core`, `mikro-orm`, `ui`, new `otel`) into flip's `telescope-local` branch, wire `traceContext: new OtelTraceContextProvider()` + a `traceLink` in `telescopeOptionsFactory`, `pnpm install`, `nest build`, reboot, and confirm entries created under an active span carry `traceId`/`spanId` (and the detail link renders). **No npm publish / git push without Davi's explicit OK.**
