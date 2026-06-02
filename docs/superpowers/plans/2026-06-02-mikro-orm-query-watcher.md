# MikroORM Query Watcher (`-mikro-orm` adapter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first ORM adapter package, `@dudousxd/nestjs-telescope-mikro-orm` — a query watcher that captures every MikroORM SQL query (`sql` / `params` / `took`), correlates it to the active request batch, tags slow queries, computes a `familyHash` for grouping, and a pure **N+1 detector** that flags a query template run too many times within one batch.

**Architecture (hybrid integration, decided):** MikroORM v7 surfaces query data through its **logger** (`loggerFactory` + a `DefaultLogger` subclass whose query log receives a structured `LogContext` with `{ query, params, took }`), gated on `debug: ['query']`. `onQuery(sql, params)` is NOT usable (pre-execution, no duration). So we ship:
1. **`TelescopeMikroOrmLogger`** — a `DefaultLogger` subclass that tees each query into a `record(input)` callback (the robust, host-wired path: the host adds it to `MikroORM.init({ loggerFactory })`).
2. **`MikroOrmQueryWatcher`** — a `Watcher` whose `register(ctx)` tries the **zero-config runtime path**: resolve the `MikroORM` instance via `ctx.moduleRef`, enable query debug, and wrap the active logger so queries flow to `ctx.record` without any host setup. If runtime logger/debug mutation proves unreliable on the installed MikroORM version, the watcher logs a clear instruction to use the host-wired logger instead (the registrar already isolates a failed `register`).

Captured queries inherit the active ALS batch (set by the request middleware's `enterWith`), so they correlate to their request automatically.

**Tech Stack:** `@mikro-orm/core` + `@mikro-orm/nestjs` (peer deps), `@mikro-orm/sqlite` (dev, for tests), Vitest, Biome. New package `packages/mikro-orm`.

**Scope:** The MikroORM query watcher + the pure family-hash / N+1 logic. The `-typeorm`/`-prisma` adapters, the Pulse-mode dashboard that surfaces N+1 insights, and Job/Mail watchers are separate plans. This plan ships working, testable software: with the adapter wired, a query run inside a request appears in `/telescope/api/entries` correlated to that request, and repeated identical queries in one batch are detectable as N+1.

**Reference:** `DESIGN.md` (§2.2 Watcher SPI, §12 N+1 detector). The core exposes `WatcherContext` (`record`/`runInBatch`/`beginBatch`/`config`/`moduleRef`), `RecordInput`, `EntryType.Query`, `QueryContent`, `Entry`, `SLOW_THRESHOLD_MS`. MikroORM v7 logging API verified from official docs (`mikro-orm.io/docs/7.0/logging`): `loggerFactory`, `DefaultLogger`, `LogContext`, `debug`.

**Conventions:** Mirror `packages/core` and the sibling `~/personal/nestjs-filter/packages/mikro-orm` adapter exactly. ESM NodeNext (`.js` imports); no `any` outside `*.spec.ts`; `exactOptionalPropertyTypes` on; Biome single quotes. Build with `tsc -p tsconfig.json`. Internal dep on core via `"@dudousxd/nestjs-telescope": "workspace:*"` (peer + dev). Commit on `main`, no Co-Authored-By.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/mikro-orm/package.json` | `@dudousxd/nestjs-telescope-mikro-orm` package manifest (mirror nestjs-filter's `-mikro-orm`). |
| `packages/mikro-orm/tsconfig.json`, `vitest.config.ts` | Build/test config (mirror core). |
| `packages/mikro-orm/src/query-family-hash.ts` | `queryFamilyHash(sql)` — normalize SQL → stable grouping hash. |
| `packages/mikro-orm/src/n-plus-one.ts` | `detectNPlusOne(queryEntries, threshold)` — pure detector. |
| `packages/mikro-orm/src/telescope-mikro-orm.logger.ts` | `TelescopeMikroOrmLogger` + `telescopeMikroOrmLogger(record)` factory. |
| `packages/mikro-orm/src/mikro-orm-query.watcher.ts` | `MikroOrmQueryWatcher` (runtime-wrap, hybrid). |
| `packages/mikro-orm/src/index.ts` | Barrel. |
| `pnpm-workspace.yaml` (already includes `packages/*`) | No change. |

---

## Task 1: Scaffold the `-mikro-orm` package

**Files:**
- Create: `packages/mikro-orm/package.json`, `packages/mikro-orm/tsconfig.json`, `packages/mikro-orm/vitest.config.ts`, `packages/mikro-orm/src/index.ts` (placeholder).

- [ ] **Step 1: Read the sibling adapter for the exact shape**

Read `~/personal/nestjs-filter/packages/mikro-orm/package.json` and mirror its structure (scripts, peerDependencies pattern, exports, `type: module`, `tsc -p tsconfig.json` build).

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "@dudousxd/nestjs-telescope-mikro-orm",
  "version": "0.0.0",
  "description": "MikroORM query watcher for @dudousxd/nestjs-telescope.",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/DavideCarvalho/nestjs-telescope.git",
    "directory": "packages/mikro-orm"
  },
  "author": "Davi Carvalho <davi@goflip.ai>",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "default": "./dist/index.js" } },
  "files": ["dist/", "README.md", "CHANGELOG.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "peerDependencies": {
    "@dudousxd/nestjs-telescope": "workspace:*",
    "@mikro-orm/core": ">=7.0.0",
    "@mikro-orm/nestjs": ">=7.0.0",
    "@nestjs/common": ">=10.0.0",
    "@nestjs/core": ">=10.0.0"
  },
  "devDependencies": {
    "@dudousxd/nestjs-telescope": "workspace:*",
    "@mikro-orm/core": "^7.0.0",
    "@mikro-orm/nestjs": "^7.0.0",
    "@mikro-orm/sqlite": "^7.0.0",
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/testing": "^11.0.0",
    "reflect-metadata": "^0.2.2",
    "typescript": "^5.4.0",
    "vitest": "^3.0.0"
  },
  "engines": { "node": ">=20" },
  "keywords": ["nestjs", "telescope", "mikro-orm", "observability", "query"]
}
```

> MikroORM **v7** (matches the sibling `nestjs-filter/packages/mikro-orm`). Read that package.json to mirror the exact dep set / scripts. The query-logging API (`loggerFactory`/`DefaultLogger`/`LogContext`) is the v7 form verified from the docs.

- [ ] **Step 3: Write `tsconfig.json` + `vitest.config.ts`** mirroring `packages/core` (same `extends ../../tsconfig.base.json`, rootDir src, outDir dist, exclude `**/*.spec.ts`). And a placeholder `src/index.ts`:

```ts
export const MIKRO_ORM_ADAPTER_VERSION = '0.0.0';
```

- [ ] **Step 4: Install + verify the workspace picks it up**

Run: `pnpm install` (root) then `pnpm --filter @dudousxd/nestjs-telescope-mikro-orm typecheck`
Expected: package resolves, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/mikro-orm pnpm-lock.yaml
git commit -m "chore(mikro-orm): scaffold the MikroORM adapter package"
```

---

## Task 2: `queryFamilyHash` — SQL normalization

Groups "the same query" regardless of bound values, for N+1 detection and the
exceptions/queries "occurrences" view.

**Files:**
- Create: `packages/mikro-orm/src/query-family-hash.ts`
- Test: `packages/mikro-orm/src/query-family-hash.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/mikro-orm/src/query-family-hash.spec.ts
import { describe, expect, it } from 'vitest';
import { queryFamilyHash } from './query-family-hash.js';

describe('queryFamilyHash', () => {
  it('hashes the same template identically regardless of bound values or whitespace', () => {
    const a = queryFamilyHash("select * from author where id = 1");
    const b = queryFamilyHash("select  *  from author  where id = 42");
    const c = queryFamilyHash("select * from author where id = ?");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('distinguishes different templates', () => {
    expect(queryFamilyHash('select * from author where id = ?')).not.toBe(
      queryFamilyHash('select * from book where id = ?'),
    );
  });

  it('normalizes case of keywords but is deterministic and non-empty', () => {
    const hash = queryFamilyHash('SELECT * FROM author');
    expect(hash).toBe(queryFamilyHash('select * from author'));
    expect(hash.length).toBeGreaterThan(0);
  });

  it("masks string literals too", () => {
    expect(queryFamilyHash("select * from author where name = 'davi'")).toBe(
      queryFamilyHash("select * from author where name = 'maria'"),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @dudousxd/nestjs-telescope-mikro-orm test -- query-family-hash.spec`. Expected: FAIL (no module).

- [ ] **Step 3: Write the implementation**

```ts
// packages/mikro-orm/src/query-family-hash.ts

/** Normalize an SQL string into a template: lowercase, collapse whitespace,
 *  replace string/number literals and bound-param placeholders with '?'. */
function normalizeSql(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/'(?:[^']|'')*'/g, '?') // string literals
    .replace(/\b\d+(?:\.\d+)?\b/g, '?') // numeric literals
    .replace(/\?/g, '?') // already-parameterized
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable 32-bit FNV-1a hash, hex-encoded. Deterministic across processes. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Grouping key for "the same query" — same template, any bound values. */
export function queryFamilyHash(sql: string): string {
  return fnv1a(normalizeSql(sql));
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm --filter @dudousxd/nestjs-telescope-mikro-orm test -- query-family-hash.spec`. Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add packages/mikro-orm/src/query-family-hash.ts packages/mikro-orm/src/query-family-hash.spec.ts
git commit -m "feat(mikro-orm): query family hash (SQL template normalization)"
```

---

## Task 3: `detectNPlusOne` — pure N+1 detector

**Files:**
- Create: `packages/mikro-orm/src/n-plus-one.ts`
- Test: `packages/mikro-orm/src/n-plus-one.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/mikro-orm/src/n-plus-one.spec.ts
import type { Entry } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { detectNPlusOne } from './n-plus-one.js';

function query(over: Partial<Entry>): Entry {
  return {
    id: 'id', batchId: 'b', type: 'query', familyHash: null, content: { sql: 'x' },
    tags: [], sequence: 0, durationMs: 1, origin: 'http', instanceId: 'i',
    createdAt: new Date(), ...over,
  };
}

describe('detectNPlusOne', () => {
  it('flags a query template that runs at least `threshold` times', () => {
    const entries: Entry[] = [
      query({ familyHash: 'h1', content: { sql: 'select * from book where author_id = ?' } }),
      query({ familyHash: 'h1', content: { sql: 'select * from book where author_id = ?' } }),
      query({ familyHash: 'h1', content: { sql: 'select * from book where author_id = ?' } }),
      query({ familyHash: 'h2', content: { sql: 'select * from author' } }),
    ];
    const insights = detectNPlusOne(entries, 3);
    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({ familyHash: 'h1', count: 3 });
    expect(insights[0]?.sql).toContain('book');
  });

  it('ignores non-query entries and templates under threshold', () => {
    const entries: Entry[] = [
      query({ familyHash: 'h1' }),
      query({ familyHash: 'h1' }),
      { ...query({ familyHash: 'h1' }), type: 'request' },
    ];
    expect(detectNPlusOne(entries, 3)).toEqual([]);
  });

  it('skips entries without a familyHash', () => {
    expect(detectNPlusOne([query({ familyHash: null }), query({ familyHash: null })], 2)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @dudousxd/nestjs-telescope-mikro-orm test -- n-plus-one.spec`. Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```ts
// packages/mikro-orm/src/n-plus-one.ts
import { type Entry, EntryType } from '@dudousxd/nestjs-telescope';

export interface NPlusOneInsight {
  familyHash: string;
  count: number;
  sql: string;
}

/** Group query entries by familyHash; report templates run >= threshold times. */
export function detectNPlusOne(entries: Entry[], threshold: number): NPlusOneInsight[] {
  const groups = new Map<string, { count: number; sql: string }>();
  for (const entry of entries) {
    if (entry.type !== EntryType.Query || entry.familyHash === null) continue;
    const sql = typeof (entry.content as { sql?: unknown }).sql === 'string'
      ? (entry.content as { sql: string }).sql
      : '';
    const existing = groups.get(entry.familyHash);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(entry.familyHash, { count: 1, sql });
    }
  }
  const insights: NPlusOneInsight[] = [];
  for (const [familyHash, group] of groups) {
    if (group.count >= threshold) {
      insights.push({ familyHash, count: group.count, sql: group.sql });
    }
  }
  return insights;
}
```

- [ ] **Step 4: Run to verify it passes** — Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add packages/mikro-orm/src/n-plus-one.ts packages/mikro-orm/src/n-plus-one.spec.ts
git commit -m "feat(mikro-orm): pure N+1 query detector"
```

---

## Task 4: `TelescopeMikroOrmLogger` (host-wired path)

A `DefaultLogger` subclass that tees each executed query into a `record` callback.
This is the robust, always-works integration; the watcher (Task 5) reuses it.

**Files:**
- Create: `packages/mikro-orm/src/telescope-mikro-orm.logger.ts`
- Test: `packages/mikro-orm/src/telescope-mikro-orm.logger.spec.ts`

- [ ] **Step 1: Confirm the MikroORM logging API against the installed version**

Before writing the test, open `@mikro-orm/core`'s types and confirm: `DefaultLogger`, `LoggerOptions`, `LogContext`, and the query-logging method. The query log method is `logQuery(context: LogContext)` (or `log('query', message, context)`); `LogContext` exposes the executed `query`, `params`, and `took` (ms). Use whichever the installed version provides — the test below asserts behavior, so adjust the override method name to match. Record what you found.

- [ ] **Step 2: Write the failing test** (drive `logQuery` directly with a fake context)

```ts
// packages/mikro-orm/src/telescope-mikro-orm.logger.spec.ts
import { describe, expect, it, vi } from 'vitest';
import type { RecordInput } from '@dudousxd/nestjs-telescope';
import { telescopeMikroOrmLogger } from './telescope-mikro-orm.logger.js';

describe('telescopeMikroOrmLogger', () => {
  it('records a query entry with sql, bindings, duration, familyHash, and slow tag', () => {
    const records: RecordInput[] = [];
    const record = (input: RecordInput) => records.push(input);
    const logger = telescopeMikroOrmLogger(record, { slowMs: 100 });

    // Drive the query-log hook with a structured context (shape per installed MikroORM).
    logger.logQuery({
      query: 'select * from author where id = ?',
      params: [42],
      took: 150,
      level: 'info',
    } as never);

    expect(records).toHaveLength(1);
    const entry = records[0]!;
    expect(entry.type).toBe('query');
    expect((entry.content as { sql: string }).sql).toContain('author');
    expect((entry.content as { bindings: unknown[] }).bindings).toEqual([42]);
    expect(entry.durationMs).toBe(150);
    expect(entry.familyHash).toBeTruthy();
    expect(entry.tags).toContain('slow'); // 150 >= 100
  });

  it('does not tag fast queries as slow', () => {
    const records: RecordInput[] = [];
    const logger = telescopeMikroOrmLogger((i) => records.push(i), { slowMs: 100 });
    logger.logQuery({ query: 'select 1', params: [], took: 5, level: 'info' } as never);
    expect(records[0]?.tags ?? []).not.toContain('slow');
  });
});
```

- [ ] **Step 3: Run to verify it fails** — Expected: FAIL (no module).

- [ ] **Step 4: Write the logger**

```ts
// packages/mikro-orm/src/telescope-mikro-orm.logger.ts
import { DefaultLogger, type LogContext, type LoggerOptions } from '@mikro-orm/core';
import { EntryType, type RecordInput } from '@dudousxd/nestjs-telescope';
import { queryFamilyHash } from './query-family-hash.js';

export interface TelescopeLoggerOptions {
  /** Queries at/above this many ms get a 'slow' tag. Default 100. */
  slowMs?: number;
}

/** A MikroORM logger that tees every executed query into `record`, while
 *  preserving MikroORM's own logging behavior. */
export class TelescopeMikroOrmLogger extends DefaultLogger {
  constructor(
    options: LoggerOptions,
    private readonly record: (input: RecordInput) => void,
    private readonly slowMs: number,
  ) {
    super(options);
  }

  override logQuery(context: LogContext): void {
    const sql = typeof context.query === 'string' ? context.query : '';
    if (sql) {
      const took = typeof context.took === 'number' ? context.took : null;
      this.record({
        type: EntryType.Query,
        content: { sql, bindings: Array.isArray(context.params) ? context.params : [], took },
        familyHash: queryFamilyHash(sql),
        durationMs: took,
        ...(took !== null && took >= this.slowMs ? { tags: ['slow'] } : {}),
      });
    }
    super.logQuery(context);
  }
}

/** Build a loggerFactory-compatible logger that records queries.
 *  Host usage: `MikroORM.init({ debug: ['query'], loggerFactory: (o) => telescopeMikroOrmLogger(record, ...)(o) })`. */
export function telescopeMikroOrmLogger(
  record: (input: RecordInput) => void,
  options: TelescopeLoggerOptions = {},
): (loggerOptions: LoggerOptions) => TelescopeMikroOrmLogger {
  const slowMs = options.slowMs ?? 100;
  return (loggerOptions: LoggerOptions) =>
    new TelescopeMikroOrmLogger(loggerOptions, record, slowMs);
}
```

> The test calls `logger.logQuery(...)` directly with a constructed logger. If the installed MikroORM's `DefaultLogger` doesn't expose `logQuery` as the override point (older/newer), adjust to the correct method (e.g. override `log(namespace, message, context)` and branch on `namespace === 'query'`), keeping the test asserting the same recorded shape. Report the exact API used.

- [ ] **Step 5: Run to verify it passes** — Expected: PASS (both). Also `typecheck` + `biome lint`.

- [ ] **Step 6: Commit**

```bash
git add packages/mikro-orm/src/telescope-mikro-orm.logger.ts packages/mikro-orm/src/telescope-mikro-orm.logger.spec.ts
git commit -m "feat(mikro-orm): query-capturing MikroORM logger"
```

---

## Task 5: `MikroOrmQueryWatcher` (hybrid runtime-wrap) + integration test

**Files:**
- Create: `packages/mikro-orm/src/mikro-orm-query.watcher.ts`
- Test: `packages/mikro-orm/src/mikro-orm-query.watcher.integration.spec.ts`

- [ ] **Step 1: Write the integration test** (real `@mikro-orm/sqlite`, real `TelescopeModule`)

Boot a Nest app with `TelescopeModule.forRoot({ authorizer: () => true, watchers: [new MikroOrmQueryWatcher()] })` plus a real MikroORM (sqlite, an `Author` entity) registered via `MikroOrmModule.forRoot(...)`. A controller method runs a query (`em.find(Author, {})`). Hit it through HTTP so the request middleware opens the batch; flush; then read `/telescope/api/entries` and assert: a `query` entry exists, its `content.sql` is the executed SQL, and its `batchId` equals the `request` entry's `batchId` (the query correlates to its request). Then issue N identical queries in one request and assert `detectNPlusOne(batchEntries, N)` finds the template.

> This test is the real validation of the hybrid runtime-wrap. Write it first; it will fail until Task 5's watcher wires MikroORM's logging to `ctx.record`. If the runtime-wrap (resolve `MikroORM`, enable `debug:['query']`, replace/wrap the logger at bootstrap) does not reliably deliver queries on the installed version, implement the documented host-wired fallback instead: in `register`, log a warning telling the host to add `loggerFactory: telescopeMikroOrmLogger(record)` to their MikroORM config, and make THIS integration test use that host-wired path (construct the ORM with the telescope `loggerFactory`). Either way the assertions (query recorded + correlated + N+1 detectable) must pass. Report which path works.

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @dudousxd/nestjs-telescope-mikro-orm test -- watcher.integration`. Expected: FAIL.

- [ ] **Step 3: Write the watcher**

```ts
// packages/mikro-orm/src/mikro-orm-query.watcher.ts
import { MikroORM } from '@mikro-orm/core';
import { Logger } from '@nestjs/common';
import type { Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';
import { EntryType } from '@dudousxd/nestjs-telescope';
import { TelescopeMikroOrmLogger } from './telescope-mikro-orm.logger.js';

export interface MikroOrmQueryWatcherOptions {
  slowMs?: number;
}

/** Captures MikroORM queries. Zero-config path: resolves the MikroORM instance
 *  at registration, enables query logging, and wraps the logger so queries flow
 *  to the recorder. Falls back to instructing host-wired loggerFactory setup. */
export class MikroOrmQueryWatcher implements Watcher {
  readonly type = EntryType.Query;
  private readonly logger = new Logger(MikroOrmQueryWatcher.name);

  constructor(private readonly options: MikroOrmQueryWatcherOptions = {}) {}

  register(ctx: WatcherContext): void {
    let orm: MikroORM | null = null;
    try {
      orm = ctx.moduleRef.get(MikroORM, { strict: false });
    } catch {
      orm = null;
    }
    if (!orm) {
      this.logger.warn(
        'MikroORM instance not found. Add `loggerFactory: telescopeMikroOrmLogger(record)` + `debug: ["query"]` to your MikroORM config to capture queries.',
      );
      return;
    }
    // Enable query logging + install the recording logger at runtime.
    const slowMs = this.options.slowMs ?? 100;
    orm.config.set('debug', ['query']);
    const recordingLogger = new TelescopeMikroOrmLogger(
      { logger: (msg: string) => orm?.config.getLogger().log('query', msg), debug: ['query'] },
      (input) => ctx.record(input),
      slowMs,
    );
    orm.config.set('logger', (msg: string) => recordingLogger.log('query', msg));
    // Some MikroORM versions cache the logger instance; replace it directly when possible.
    const configWithLogger = orm.config as unknown as { logger?: unknown };
    configWithLogger.logger = recordingLogger;
  }
}
```

> **This Step 3 code is a starting point, not gospel.** The runtime logger/debug mutation is the version-sensitive part. Verify against the real sqlite ORM in the integration test: does setting `debug`/`logger` at runtime actually route `logQuery` to our logger? If MikroORM caches the logger such that runtime replacement doesn't take effect, switch the watcher to the host-wired fallback (warn + no-op) and make the integration test construct the ORM with `loggerFactory: telescopeMikroOrmLogger((i) => /* the telescope service */ .record(i))`. Keep the no-`any` rule (narrow casts as needed). Report the working approach as DONE content.

- [ ] **Step 4: Run to verify it passes** — the integration test goes green (query recorded + correlated + N+1 detectable). Whole-package + typecheck + lint clean.

- [ ] **Step 5: Commit**

```bash
git add packages/mikro-orm/src/mikro-orm-query.watcher.ts packages/mikro-orm/src/mikro-orm-query.watcher.integration.spec.ts
git commit -m "feat(mikro-orm): MikroORM query watcher (hybrid runtime-wrap + fallback)"
```

---

## Task 6: Barrel + build + README + full verification

**Files:**
- Modify: `packages/mikro-orm/src/index.ts`
- Create: `packages/mikro-orm/README.md`

- [ ] **Step 1: Barrel**

```ts
// packages/mikro-orm/src/index.ts
export * from './query-family-hash.js';
export * from './n-plus-one.js';
export * from './telescope-mikro-orm.logger.js';
export * from './mikro-orm-query.watcher.js';
```

- [ ] **Step 2: README** — short, code-first: install (`@dudousxd/nestjs-telescope` + `-mikro-orm`), add `new MikroOrmQueryWatcher()` to `watchers`, and the host-wired fallback snippet (`loggerFactory: telescopeMikroOrmLogger(...)`), documenting whichever path the integration validated.

- [ ] **Step 3: Full verification** — all clean:
```
pnpm --filter @dudousxd/nestjs-telescope-mikro-orm typecheck
pnpm --filter @dudousxd/nestjs-telescope-mikro-orm build
pnpm --filter @dudousxd/nestjs-telescope-mikro-orm test
pnpm lint
```
Expected: `dist/` emits (no spec files); all specs pass; Biome clean.

- [ ] **Step 4: Commit**

```bash
git add packages/mikro-orm/src/index.ts packages/mikro-orm/README.md
git commit -m "feat(mikro-orm): barrel + README + verification"
```

---

## After this plan

The MikroORM adapter captures and correlates queries, with N+1 detection ready.
Follow-ons: `-typeorm` (EventSubscriber/logger) + `-prisma` ($on('query')) adapters;
the **Pulse-mode** dashboard surfacing N+1 insights as cards; Job + Mail watchers
(→ Horizon-style queue metrics).
