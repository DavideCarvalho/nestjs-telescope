# NestJS Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host the (already-built, framework-agnostic) capture spine inside NestJS so a real app can mount Telescope: a `TelescopeModule`, a `TelescopeService` that owns the Recorder lifecycle (flush timer + graceful shutdown drain), the default **SQLite storage provider**, a headless HTTP API behind an authorizer **guard** (default-deny in production), a scheduled **pruner**, and the **Watcher SPI** types the next plan's watchers implement.

**Architecture:** `TelescopeModule.forRoot(options)` resolves config (Task uses the spine's `resolveConfig`), constructs a `StorageProvider` (default `SqliteStorageProvider`), and provides a singleton `TelescopeService` that builds the `Recorder` (spine) + a `TelescopeContext` + a uuid `idFactory`, starts a flush interval, and drains on shutdown. A plain Nest controller exposes the headless API; a plain Nest guard gates it. Both controller and guard are platform-agnostic (work on Express and Fastify unchanged). Watchers are registered but none ship in this plan — they arrive next.

**Tech Stack:** NestJS 11 (`@nestjs/common`/`core`, peer deps), `better-sqlite3`, `uuid`, Vitest, Biome. All in `packages/core` (`@dudousxd/nestjs-telescope`). The flush timer and pruner use plain `setInterval().unref()` — no `@nestjs/schedule` dependency.

**Dev dependencies to add** to `packages/core/package.json` for this plan's tests: `supertest`, `@types/supertest` (Task 7 e2e), `@nestjs/platform-fastify` (Task 8 parity). `better-sqlite3` + `uuid` are already runtime deps from the spine.

**Scope:** Runnable host only. The Request/Exception watchers (and their ALS batch lifecycle across Express/Fastify), then Job/Mail/Query watchers, then the expanded roster and Pulse/N+1/queue features, are separate plans. This plan ships working, testable software: a Nest app importing `TelescopeModule` gets a queryable Telescope API backed by SQLite, with flush + prune lifecycle — verifiable by seeding the store and hitting the API, and by unit-testing the service lifecycle.

**Reference:** `DESIGN.md` (§2 SPIs, §4 config, §5 HTTP surface, §11 platform support). The capture spine is complete in `packages/core/src` (entry, redaction, context, storage SPI + `InMemoryStorageProvider`, taggers, `Recorder`, `resolveConfig`). Reuse those exports — do not reimplement.

**Conventions (verified in repo):**
- ESM NodeNext: relative imports end in `.js`. No `any` outside `*.spec.ts`. `exactOptionalPropertyTypes` on (use conditional spreads, never assign `undefined` to optional fields). Biome: single quotes, semicolons, 100 cols.
- Tests co-located `*.spec.ts`; run `pnpm --filter @dudousxd/nestjs-telescope test -- <name>.spec`. Commit on `main` with `git -c user.name="Davi Carvalho" -c user.email="davi@goflip.ai" commit`, no Co-Authored-By.
- `better-sqlite3`, `uuid`, `@nestjs/schedule` go in `packages/core/package.json` dependencies (add `@nestjs/schedule` + its peer `@nestjs/common` already present; add `@types`/devDeps as needed).

**Spine exports this plan consumes** (from `@dudousxd/nestjs-telescope` barrel / relative `../`):
`Entry`, `RecordInput`, `BatchOrigin`, `StorageProvider`, `EntryQuery`, `Page`, `TagCount`, `EntryWithBatch`, `Recorder`, `RecorderOptions`, `TelescopeContext`, `createBatch`, `resolveConfig`, `ResolvedCoreConfig`, `TelescopeCoreOptions`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/core/src/nest/watcher.ts` | `Watcher`, `WatcherContext`, `BatchHandle` SPI (no impls yet). |
| `packages/core/src/storage/sqlite-storage-provider.ts` | Default `StorageProvider` over `better-sqlite3`. |
| `packages/core/src/nest/telescope.options.ts` | `TelescopeModuleOptions` (core options + Nest-only: `path`, `authorizer`, `watchers`) + DI tokens. |
| `packages/core/src/nest/telescope.service.ts` | Owns Recorder + context + storage; flush timer; shutdown drain; `record`/`runInBatch`/`getMeta`. |
| `packages/core/src/nest/telescope.guard.ts` | `TelescopeGuard` calling the authorizer (default-deny in production). |
| `packages/core/src/nest/telescope.controller.ts` | Headless API (`/telescope/api/*`). |
| `packages/core/src/nest/telescope-pruner.service.ts` | Scheduled retention pruning. |
| `packages/core/src/nest/telescope.module.ts` | `forRoot`/`forRootAsync` dynamic module wiring everything. |
| `packages/core/src/index.ts` (modify) | Export the nest/ + sqlite public surface. |

---

## Task 1: Watcher SPI

The contract the next plan's watchers implement. Types only — no behavior.

**Files:**
- Create: `packages/core/src/nest/watcher.ts`
- Test: `packages/core/src/nest/watcher.spec.ts`

- [ ] **Step 1: Write the failing test** (a type-level + structural smoke test)

```ts
// packages/core/src/nest/watcher.spec.ts
import { describe, expect, it } from 'vitest';
import type { BatchHandle, Watcher, WatcherContext } from './watcher.js';

describe('Watcher SPI', () => {
  it('lets a minimal watcher be defined against the interface', () => {
    const calls: string[] = [];
    const watcher: Watcher = {
      type: 'demo',
      register(ctx: WatcherContext) {
        calls.push(`registered:${ctx.config.instanceId}`);
      },
    };
    const handle: BatchHandle = { id: 'b1', end: () => calls.push('ended') };
    const ctx = {
      record: () => calls.push('recorded'),
      beginBatch: () => handle,
      runInBatch: <T>(_o: BatchOriginLike, fn: () => Promise<T>) => fn(),
      config: { instanceId: 'pod-1' },
    } as unknown as WatcherContext;

    watcher.register(ctx);
    ctx.record({ type: 'demo', content: {} });
    handle.end();

    expect(watcher.type).toBe('demo');
    expect(calls).toEqual(['registered:pod-1', 'recorded', 'ended']);
  });
});

type BatchOriginLike = 'http' | 'queue' | 'schedule' | 'cli' | 'manual';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- watcher.spec`
Expected: FAIL — cannot find module `./watcher.js`.

- [ ] **Step 3: Write the SPI**

```ts
// packages/core/src/nest/watcher.ts
import type { ModuleRef } from '@nestjs/core';
import type { BatchOrigin, RecordInput } from '../entry/entry.js';
import type { ResolvedCoreConfig } from '../config/options.js';

/** Handle to an open entry-point batch. */
export interface BatchHandle {
  readonly id: string;
  /** Close the batch (ends the ALS scope if this handle opened one). */
  end(): void;
}

/** Everything a watcher is handed at registration time. */
export interface WatcherContext {
  /** Hand an entry to the Recorder — fire-and-forget, never throws/blocks. */
  record(input: RecordInput): void;
  /** Open a batch and run `fn` inside its ALS scope (entry-point watchers). */
  runInBatch<T>(origin: BatchOrigin, fn: () => Promise<T>): Promise<T>;
  /** Open a batch without a callback scope (caller must `end()` it). */
  beginBatch(origin: BatchOrigin): BatchHandle;
  readonly config: ResolvedCoreConfig;
  readonly moduleRef: ModuleRef;
}

/** A source of entries. Built-ins and community watchers implement this. */
export interface Watcher {
  /** The entry `type` this watcher produces. */
  readonly type: string;
  /** Wire framework hooks; called once during module init. */
  register(ctx: WatcherContext): void | Promise<void>;
  /** Optional cheap pre-filter before constructing an entry. */
  shouldRecord?(candidate: unknown): boolean;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- watcher.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/nest/watcher.ts packages/core/src/nest/watcher.spec.ts
git commit -m "feat(core): Watcher SPI (watcher/context/batch-handle)"
```

---

## Task 2: SqliteStorageProvider

The default store. Mirrors `InMemoryStorageProvider` semantics over `better-sqlite3`,
using SQLite JSON1 (`json_each`) for tag filtering/counts. Cursor is an opaque
composite keyset of `(created_at,id)` (per-provider opaque, per the SPI).

**Files:**
- Create: `packages/core/src/storage/sqlite-storage-provider.ts`
- Test: `packages/core/src/storage/sqlite-storage-provider.spec.ts`

- [ ] **Step 1: Write the failing test** (reuse the InMemory contract shape against `:memory:`)

```ts
// packages/core/src/storage/sqlite-storage-provider.spec.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { SqliteStorageProvider } from './sqlite-storage-provider.js';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'id', batchId: 'b', type: 'request', familyHash: null, content: {},
    tags: [], sequence: 0, durationMs: null, origin: 'http', instanceId: 'i',
    createdAt: new Date('2026-01-01T00:00:00Z'), ...over,
  };
}

describe('SqliteStorageProvider', () => {
  let store: SqliteStorageProvider;
  beforeEach(() => { store = new SqliteStorageProvider({ path: ':memory:' }); });
  afterEach(() => { store.close(); });

  it('stores and finds an entry with its batch (sequence-ordered)', async () => {
    await store.store([
      entry({ id: '1', batchId: 'b', sequence: 0, content: { a: 1 } }),
      entry({ id: '2', batchId: 'b', type: 'query', sequence: 1 }),
    ]);
    const found = await store.find('1');
    expect(found?.id).toBe('1');
    expect((found?.content as { a: number }).a).toBe(1);
    expect(found?.batch.map((e) => e.id)).toEqual(['1', '2']);
  });

  it('filters by type and tag (json_each)', async () => {
    await store.store([
      entry({ id: '1', type: 'request', tags: ['status:200'] }),
      entry({ id: '2', type: 'query', tags: ['slow'] }),
    ]);
    expect((await store.get({ type: 'query' })).data.map((e) => e.id)).toEqual(['2']);
    expect((await store.get({ tag: 'slow' })).data.map((e) => e.id)).toEqual(['2']);
  });

  it('paginates newest-first with an opaque cursor', async () => {
    await store.store([
      entry({ id: '1', createdAt: new Date('2026-01-01T00:00:01Z') }),
      entry({ id: '2', createdAt: new Date('2026-01-01T00:00:02Z') }),
      entry({ id: '3', createdAt: new Date('2026-01-01T00:00:03Z') }),
    ]);
    const page1 = await store.get({ limit: 2 });
    expect(page1.data.map((e) => e.id)).toEqual(['3', '2']);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await store.get({ limit: 2, ...(page1.nextCursor ? { cursor: page1.nextCursor } : {}) });
    expect(page2.data.map((e) => e.id)).toEqual(['1']);
    expect(page2.nextCursor).toBeNull();
  });

  it('aggregates tag counts and prunes by age', async () => {
    await store.store([
      entry({ id: '1', tags: ['slow'], createdAt: new Date('2026-01-01T00:00:00Z') }),
      entry({ id: '2', tags: ['slow'], createdAt: new Date('2026-02-01T00:00:00Z') }),
    ]);
    expect(await store.tags()).toContainEqual({ tag: 'slow', count: 2 });
    expect(await store.prune(new Date('2026-01-15T00:00:00Z'))).toBe(1);
    expect((await store.get({})).data.map((e) => e.id)).toEqual(['2']);
  });

  it('update patches fields but never the id', async () => {
    await store.store([entry({ id: '1', durationMs: null })]);
    await store.update('1', { durationMs: 42, id: 'hacked' });
    const found = await store.find('1');
    expect(found?.id).toBe('1');
    expect(found?.durationMs).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- sqlite-storage-provider.spec`
Expected: FAIL — cannot find module `./sqlite-storage-provider.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/storage/sqlite-storage-provider.ts
import Database from 'better-sqlite3';
import type { Entry } from '../entry/entry.js';
import { isBatchOrigin } from '../entry/entry.js';
import type {
  EntryQuery,
  EntryWithBatch,
  Page,
  StorageProvider,
  TagCount,
} from './storage-provider.js';

export interface SqliteStorageOptions {
  /** File path or ':memory:'. Defaults to ':memory:'. */
  path?: string;
}

const DEFAULT_LIMIT = 50;

interface Row {
  id: string;
  batch_id: string;
  type: string;
  family_hash: string | null;
  content: string;
  tags: string;
  sequence: number;
  duration_ms: number | null;
  origin: string;
  instance_id: string;
  created_at: number;
}

/** Default storage provider: embedded SQLite via better-sqlite3, JSON1 for tags. */
export class SqliteStorageProvider implements StorageProvider {
  private readonly db: Database.Database;

  constructor(options: SqliteStorageOptions = {}) {
    this.db = new Database(options.path ?? ':memory:');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      create table if not exists telescope_entries (
        id text primary key,
        batch_id text not null,
        type text not null,
        family_hash text,
        content text not null,
        tags text not null,
        sequence integer not null,
        duration_ms integer,
        origin text not null,
        instance_id text not null,
        created_at integer not null
      );
      create index if not exists ix_te_created on telescope_entries (created_at, id);
      create index if not exists ix_te_type_created on telescope_entries (type, created_at);
      create index if not exists ix_te_batch on telescope_entries (batch_id, sequence);
      create index if not exists ix_te_family on telescope_entries (family_hash);
    `);
  }

  close(): void {
    this.db.close();
  }

  async store(entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const insert = this.db.prepare(
      `insert or replace into telescope_entries
       (id, batch_id, type, family_hash, content, tags, sequence, duration_ms, origin, instance_id, created_at)
       values (@id, @batch_id, @type, @family_hash, @content, @tags, @sequence, @duration_ms, @origin, @instance_id, @created_at)`,
    );
    const tx = this.db.transaction((rows: Row[]) => {
      for (const row of rows) insert.run(row);
    });
    tx(entries.map((entry) => this.toRow(entry)));
  }

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    const existing = this.findRow(id);
    if (!existing) return;
    const merged: Entry = { ...this.fromRow(existing), ...patch, id: existing.id };
    await this.store([merged]);
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    const row = this.findRow(id);
    if (!row) return null;
    const entry = this.fromRow(row);
    return { ...entry, batch: await this.batch(entry.batchId) };
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (query.type !== undefined) { where.push('type = @type'); params.type = query.type; }
    if (query.familyHash !== undefined) { where.push('family_hash = @familyHash'); params.familyHash = query.familyHash; }
    if (query.batchId !== undefined) { where.push('batch_id = @batchId'); params.batchId = query.batchId; }
    if (query.before !== undefined) { where.push('created_at < @before'); params.before = query.before.getTime(); }
    if (query.after !== undefined) { where.push('created_at > @after'); params.after = query.after.getTime(); }
    if (query.tag !== undefined) {
      where.push('exists (select 1 from json_each(telescope_entries.tags) where value = @tag)');
      params.tag = query.tag;
    }
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    if (cursor) {
      where.push('(created_at < @cCreated or (created_at = @cCreated and id < @cId))');
      params.cCreated = cursor.createdAt;
      params.cId = cursor.id;
    }
    const limit = query.limit ?? DEFAULT_LIMIT;
    const sql = `select * from telescope_entries
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by created_at desc, id desc limit @limit`;
    params.limit = limit + 1; // fetch one extra to know if there's a next page
    const rows = this.db.prepare(sql).all(params) as Row[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((row) => this.fromRow(row));
    const last = page.at(-1);
    return {
      data: page,
      nextCursor: hasMore && last ? this.encodeCursor(last.createdAt.getTime(), last.id) : null,
    };
  }

  async batch(batchId: string): Promise<Entry[]> {
    const rows = this.db
      .prepare('select * from telescope_entries where batch_id = ? order by sequence asc')
      .all(batchId) as Row[];
    return rows.map((row) => this.fromRow(row));
  }

  async tags(prefix?: string): Promise<TagCount[]> {
    const sql = `select value as tag, count(*) as count
      from telescope_entries, json_each(telescope_entries.tags)
      ${prefix !== undefined ? "where value like @prefix || '%'" : ''}
      group by value`;
    const rows = this.db.prepare(sql).all(prefix !== undefined ? { prefix } : {}) as {
      tag: string;
      count: number;
    }[];
    return rows.map((row) => ({ tag: row.tag, count: row.count }));
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    const cutoff = olderThan.getTime();
    if (keepLast === undefined) {
      return this.db
        .prepare('delete from telescope_entries where created_at < ?')
        .run(cutoff).changes;
    }
    return this.db
      .prepare(
        `delete from telescope_entries
         where created_at < @cutoff
           and id not in (
             select id from telescope_entries where created_at < @cutoff
             order by created_at desc, id desc limit @keepLast
           )`,
      )
      .run({ cutoff, keepLast }).changes;
  }

  async clear(): Promise<void> {
    this.db.exec('delete from telescope_entries');
  }

  private findRow(id: string): Row | undefined {
    return this.db.prepare('select * from telescope_entries where id = ?').get(id) as
      | Row
      | undefined;
  }

  private toRow(entry: Entry): Row {
    return {
      id: entry.id,
      batch_id: entry.batchId,
      type: entry.type,
      family_hash: entry.familyHash,
      content: JSON.stringify(entry.content),
      tags: JSON.stringify(entry.tags),
      sequence: entry.sequence,
      duration_ms: entry.durationMs,
      origin: entry.origin,
      instance_id: entry.instanceId,
      created_at: entry.createdAt.getTime(),
    };
  }

  private fromRow(row: Row): Entry {
    return {
      id: row.id,
      batchId: row.batch_id,
      type: row.type,
      familyHash: row.family_hash,
      content: JSON.parse(row.content),
      tags: JSON.parse(row.tags) as string[],
      sequence: row.sequence,
      durationMs: row.duration_ms,
      origin: isBatchOrigin(row.origin) ? row.origin : 'manual',
      instanceId: row.instance_id,
      createdAt: new Date(row.created_at),
    };
  }

  private encodeCursor(createdAt: number, id: string): string {
    return Buffer.from(`${createdAt}:${id}`).toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: number; id: string } | null {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep === -1) return null;
    const createdAt = Number(decoded.slice(0, sep));
    if (Number.isNaN(createdAt)) return null;
    return { createdAt, id: decoded.slice(sep + 1) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- sqlite-storage-provider.spec`
Expected: PASS (all five cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/storage/sqlite-storage-provider.ts packages/core/src/storage/sqlite-storage-provider.spec.ts
git commit -m "feat(core): SQLite storage provider (default store)"
```

---

## Task 3: Options + DI tokens

**Files:**
- Create: `packages/core/src/nest/telescope.options.ts`

- [ ] **Step 1: Write the options + tokens**

```ts
// packages/core/src/nest/telescope.options.ts
import type { TelescopeCoreOptions } from '../config/options.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { Watcher } from './watcher.js';

/** Context handed to the authorizer to decide API/UI access. */
export interface AuthorizerContext {
  /** The platform request object (Express or Fastify). */
  request: unknown;
}

export interface TelescopeModuleOptions extends TelescopeCoreOptions {
  /** Storage provider. Defaults to a SqliteStorageProvider(':memory:'). */
  storage?: StorageProvider;
  /** Watchers to register. Empty in the host plan. */
  watchers?: Watcher[];
  /**
   * Authorizes API access. Default: allow when NODE_ENV !== 'production',
   * deny otherwise (until the host supplies one).
   */
  authorizer?: (ctx: AuthorizerContext) => boolean | Promise<boolean>;
}

export interface TelescopeOptionsFactory {
  createTelescopeOptions(): Promise<TelescopeModuleOptions> | TelescopeModuleOptions;
}

export const TELESCOPE_OPTIONS = Symbol('TELESCOPE_OPTIONS');
export const TELESCOPE_STORAGE = Symbol('TELESCOPE_STORAGE');
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @dudousxd/nestjs-telescope typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/nest/telescope.options.ts
git commit -m "feat(core): TelescopeModule options and DI tokens"
```

---

## Task 4: TelescopeService (Recorder lifecycle)

Owns the Recorder + context + storage. Starts a flush interval on init, drains on
shutdown, exposes `record`/`runInBatch`/`getMeta` for watchers and the API.

**Files:**
- Create: `packages/core/src/nest/telescope.service.ts`
- Test: `packages/core/src/nest/telescope.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/nest/telescope.service.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeService } from './telescope.service.js';

function makeService(storage = new InMemoryStorageProvider()) {
  const config = resolveConfig({ recorder: { flushIntervalMs: 5 } });
  const service = new TelescopeService(config, storage);
  return { service, storage, config };
}

describe('TelescopeService', () => {
  let active: TelescopeService | null = null;
  afterEach(async () => { await active?.onApplicationShutdown(); active = null; });

  it('records and flushes a correlated batch on demand', async () => {
    const { service, storage } = makeService();
    active = service;
    await service.runInBatch('http', async () => {
      service.record({ type: 'request', content: { statusCode: 200 } });
      service.record({ type: 'query', content: {} });
    });
    await service.flush();
    const all = (await storage.get({})).data;
    expect(all).toHaveLength(2);
    expect(new Set(all.map((e) => e.batchId)).size).toBe(1); // same batch
  });

  it('drains the buffer on application shutdown', async () => {
    const { service, storage } = makeService();
    service.record({ type: 'exception', content: {} });
    await service.onApplicationShutdown();
    expect((await storage.get({})).data).toHaveLength(1);
  });

  it('getMeta reports enabled watchers, dropped count, and storage ok', async () => {
    const { service } = makeService();
    active = service;
    const meta = await service.getMeta();
    expect(meta.enabled).toBe(true);
    expect(meta.droppedCount).toBe(0);
    expect(Array.isArray(meta.watchers)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.service.spec`
Expected: FAIL — cannot find module `./telescope.service.js`.

- [ ] **Step 3: Write the service**

```ts
// packages/core/src/nest/telescope.service.ts
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { v7 } from 'uuid';
import type { ResolvedCoreConfig } from '../config/options.js';
import { createBatch } from '../context/batch.js';
import { TelescopeContext } from '../context/telescope-context.js';
import type { BatchOrigin, RecordInput } from '../entry/entry.js';
import { Recorder } from '../recorder/recorder.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { TELESCOPE_OPTIONS, TELESCOPE_STORAGE } from './telescope.options.js';

export interface TelescopeMeta {
  enabled: boolean;
  droppedCount: number;
  watchers: string[];
}

@Injectable()
export class TelescopeService implements OnModuleInit, OnApplicationShutdown {
  readonly context = new TelescopeContext();
  private readonly recorder: Recorder;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private watcherTypes: string[] = [];

  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly config: ResolvedCoreConfig,
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
  ) {
    this.recorder = new Recorder({
      storage,
      context: this.context,
      instanceId: config.instanceId,
      taggers: config.taggers,
      redact: config.redact,
      sampling: config.sampling,
      bufferSize: config.recorder.bufferSize,
      idFactory: () => v7(),
      ...(config.filter ? { filter: config.filter } : {}),
    });
  }

  onModuleInit(): void {
    if (!this.config.enabled) return;
    this.flushTimer = setInterval(() => {
      void this.recorder.flush();
    }, this.config.recorder.flushIntervalMs);
    // Don't keep the event loop alive solely for the flush timer.
    this.flushTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.recorder.flush();
  }

  /** Register the set of active watcher type names (for meta). */
  setWatchers(types: string[]): void {
    this.watcherTypes = types;
  }

  record(input: RecordInput): void {
    if (!this.config.enabled) return;
    this.recorder.record(input);
  }

  runInBatch<T>(origin: BatchOrigin, fn: () => Promise<T>): Promise<T> {
    const batch = createBatch(origin, () => v7());
    return this.context.run(batch, fn);
  }

  async flush(): Promise<void> {
    await this.recorder.flush();
  }

  async getMeta(): Promise<TelescopeMeta> {
    return {
      enabled: this.config.enabled,
      droppedCount: this.recorder.droppedCount,
      watchers: this.watcherTypes,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.service.spec`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/nest/telescope.service.ts packages/core/src/nest/telescope.service.spec.ts
git commit -m "feat(core): TelescopeService recorder lifecycle"
```

---

## Task 5: TelescopeGuard (authorizer, default-deny in prod)

**Files:**
- Create: `packages/core/src/nest/telescope.guard.ts`
- Test: `packages/core/src/nest/telescope.guard.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/nest/telescope.guard.spec.ts
import type { ExecutionContext } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { TelescopeGuard } from './telescope.guard.js';

function ctx(): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ url: '/telescope/api/meta' }) }),
  } as unknown as ExecutionContext;
}

describe('TelescopeGuard', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = original; });

  it('uses the provided authorizer when set', async () => {
    const guard = new TelescopeGuard({ authorizer: () => true });
    expect(await guard.canActivate(ctx())).toBe(true);
    const deny = new TelescopeGuard({ authorizer: () => false });
    expect(await deny.canActivate(ctx())).toBe(false);
  });

  it('defaults to allow outside production', async () => {
    process.env.NODE_ENV = 'development';
    const guard = new TelescopeGuard({});
    expect(await guard.canActivate(ctx())).toBe(true);
  });

  it('defaults to DENY in production when no authorizer is set', async () => {
    process.env.NODE_ENV = 'production';
    const guard = new TelescopeGuard({});
    expect(await guard.canActivate(ctx())).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.guard.spec`
Expected: FAIL — cannot find module `./telescope.guard.js`.

- [ ] **Step 3: Write the guard**

```ts
// packages/core/src/nest/telescope.guard.ts
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';

@Injectable()
export class TelescopeGuard implements CanActivate {
  constructor(@Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<unknown>();
    if (this.options.authorizer) {
      return this.options.authorizer({ request });
    }
    // Safe default: open in dev, closed in production.
    return process.env.NODE_ENV !== 'production';
  }
}
```

> Note on DI: this guard is constructed by the module against `TELESCOPE_OPTIONS`,
> which holds the *raw* `TelescopeModuleOptions` (it needs `authorizer`). The
> service receives the *resolved* core config under the same token? No — use a
> distinct token. The module (Task 7) provides the raw options under
> `TELESCOPE_OPTIONS` and the resolved config under a separate `TELESCOPE_CONFIG`
> token. Adjust Task 4's `@Inject(TELESCOPE_OPTIONS)` to `@Inject(TELESCOPE_CONFIG)`
> for the resolved `ResolvedCoreConfig`, and add `TELESCOPE_CONFIG` to
> `telescope.options.ts`. (Do this when wiring Task 7; update the service inject
> accordingly and re-run its test.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.guard.spec`
Expected: PASS (all three cases).

- [ ] **Step 5: Add `TELESCOPE_CONFIG` token + fix the service inject**

In `telescope.options.ts` add: `export const TELESCOPE_CONFIG = Symbol('TELESCOPE_CONFIG');`
In `telescope.service.ts` change the first constructor inject from `@Inject(TELESCOPE_OPTIONS)` to `@Inject(TELESCOPE_CONFIG)` (the resolved `ResolvedCoreConfig`). Re-run `telescope.service.spec` — still green (the spec constructs the service directly, no DI).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/nest/telescope.guard.ts packages/core/src/nest/telescope.guard.spec.ts packages/core/src/nest/telescope.options.ts packages/core/src/nest/telescope.service.ts
git commit -m "feat(core): TelescopeGuard with default-deny-in-prod authorizer"
```

---

## Task 6: Headless API controller

Plain Nest controller (works on Express and Fastify). Reads via `TelescopeService`'s
storage. Gated by `TelescopeGuard`.

**Files:**
- Create: `packages/core/src/nest/telescope.controller.ts`
- Test: `packages/core/src/nest/telescope.controller.spec.ts`

- [ ] **Step 1: Write the failing test** (unit-level: construct controller with a seeded store)

```ts
// packages/core/src/nest/telescope.controller.spec.ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { resolveConfig } from '../config/resolve-config.js';
import { TelescopeService } from './telescope.service.js';
import { TelescopeController } from './telescope.controller.js';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'id', batchId: 'b', type: 'request', familyHash: null, content: {},
    tags: [], sequence: 0, durationMs: null, origin: 'http', instanceId: 'i',
    createdAt: new Date('2026-01-01T00:00:00Z'), ...over,
  };
}

function setup() {
  const storage = new InMemoryStorageProvider();
  const service = new TelescopeService(resolveConfig({}), storage);
  const controller = new TelescopeController(storage, service);
  return { storage, controller };
}

describe('TelescopeController', () => {
  it('lists entries filtered by type', async () => {
    const { storage, controller } = setup();
    await storage.store([entry({ id: '1', type: 'request' }), entry({ id: '2', type: 'query' })]);
    const page = await controller.list({ type: 'query' });
    expect(page.data.map((e) => e.id)).toEqual(['2']);
  });

  it('returns an entry with its batch', async () => {
    const { storage, controller } = setup();
    await storage.store([entry({ id: '1', batchId: 'b', sequence: 0 }), entry({ id: '2', batchId: 'b', sequence: 1 })]);
    const found = await controller.show('1');
    expect(found?.batch.map((e) => e.id)).toEqual(['1', '2']);
  });

  it('exposes meta', async () => {
    const { controller } = setup();
    const meta = await controller.meta();
    expect(meta.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.controller.spec`
Expected: FAIL — cannot find module `./telescope.controller.js`.

- [ ] **Step 3: Write the controller**

```ts
// packages/core/src/nest/telescope.controller.ts
import { Controller, Delete, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import type { EntryQuery, Page, StorageProvider, TagCount } from '../storage/storage-provider.js';
import type { Entry, EntryWithBatch } from '../entry/entry.js';
import { TELESCOPE_STORAGE } from './telescope.options.js';
import { TelescopeGuard } from './telescope.guard.js';
import { TelescopeService, type TelescopeMeta } from './telescope.service.js';

interface ListQuery {
  type?: string;
  tag?: string;
  familyHash?: string;
  batchId?: string;
  cursor?: string;
  limit?: string;
}

@UseGuards(TelescopeGuard)
@Controller('telescope/api')
export class TelescopeController {
  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    private readonly service: TelescopeService,
  ) {}

  @Get('entries')
  list(@Query() query: ListQuery): Promise<Page<Entry>> {
    const entryQuery: EntryQuery = {
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.tag !== undefined ? { tag: query.tag } : {}),
      ...(query.familyHash !== undefined ? { familyHash: query.familyHash } : {}),
      ...(query.batchId !== undefined ? { batchId: query.batchId } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
    };
    return this.storage.get(entryQuery);
  }

  @Get('entries/:id')
  show(@Param('id') id: string): Promise<EntryWithBatch | null> {
    return this.storage.find(id);
  }

  @Get('batches/:id')
  batch(@Param('id') id: string): Promise<Entry[]> {
    return this.storage.batch(id);
  }

  @Get('tags')
  tags(@Query('prefix') prefix?: string): Promise<TagCount[]> {
    return this.storage.tags(prefix);
  }

  @Get('meta')
  meta(): Promise<TelescopeMeta> {
    return this.service.getMeta();
  }

  @Delete('entries')
  async clear(): Promise<{ cleared: true }> {
    await this.storage.clear();
    return { cleared: true };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.controller.spec`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/nest/telescope.controller.ts packages/core/src/nest/telescope.controller.spec.ts
git commit -m "feat(core): headless Telescope API controller"
```

---

## Task 7: Pruner + TelescopeModule (forRoot/forRootAsync)

**Files:**
- Create: `packages/core/src/nest/telescope-pruner.service.ts`, `packages/core/src/nest/telescope.module.ts`
- Test: `packages/core/src/nest/telescope.module.spec.ts`

- [ ] **Step 1: Write the failing integration test** (boot a real Nest app, hit the API)

```ts
// packages/core/src/nest/telescope.module.spec.ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { TelescopeModule } from './telescope.module.js';
import { TelescopeService } from './telescope.service.js';

describe('TelescopeModule (e2e, Express)', () => {
  let app: INestApplication;
  afterEach(async () => { await app?.close(); });

  it('boots, records via the service, and serves the gated API', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true })],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    const service = app.get(TelescopeService);
    await service.runInBatch('http', async () => {
      service.record({ type: 'request', content: { statusCode: 200 } });
    });
    await service.flush();

    const res = await request(app.getHttpServer()).get('/telescope/api/entries').expect(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].type).toBe('request');

    const meta = await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
    expect(meta.body.enabled).toBe(true);
  });

  it('denies the API when the authorizer returns false', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => false })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await request(app.getHttpServer()).get('/telescope/api/meta').expect(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.module.spec`
Expected: FAIL — cannot find module `./telescope.module.js`.

- [ ] **Step 3: Write the pruner**

```ts
// packages/core/src/nest/telescope-pruner.service.ts
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { ResolvedCoreConfig } from '../config/options.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { TELESCOPE_CONFIG, TELESCOPE_STORAGE } from './telescope.options.js';

@Injectable()
export class TelescopePruner implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
  ) {}

  onApplicationBootstrap(): void {
    const prune = this.config.prune;
    if (!this.config.enabled || !prune) return;
    this.timer = setInterval(() => {
      const cutoff = new Date(Date.now() - prune.afterMs);
      void this.storage.prune(cutoff, prune.keepLast);
    }, prune.intervalMs);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 4: Write the module**

```ts
// packages/core/src/nest/telescope.module.ts
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { resolveConfig } from '../config/resolve-config.js';
import { SqliteStorageProvider } from '../storage/sqlite-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { TelescopeController } from './telescope.controller.js';
import { TelescopeGuard } from './telescope.guard.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_OPTIONS,
  TELESCOPE_STORAGE,
  type TelescopeModuleOptions,
} from './telescope.options.js';
import { TelescopePruner } from './telescope-pruner.service.js';
import { TelescopeService } from './telescope.service.js';

const SHARED_PROVIDERS: Provider[] = [
  {
    provide: TELESCOPE_CONFIG,
    useFactory: (options: TelescopeModuleOptions) => resolveConfig(options),
    inject: [TELESCOPE_OPTIONS],
  },
  {
    provide: TELESCOPE_STORAGE,
    useFactory: (options: TelescopeModuleOptions): StorageProvider =>
      options.storage ?? new SqliteStorageProvider(),
    inject: [TELESCOPE_OPTIONS],
  },
  TelescopeService,
  TelescopeGuard,
  TelescopePruner,
];

@Module({})
export class TelescopeModule {
  static forRoot(options: TelescopeModuleOptions = {}): DynamicModule {
    return {
      module: TelescopeModule,
      controllers: [TelescopeController],
      providers: [{ provide: TELESCOPE_OPTIONS, useValue: options }, ...SHARED_PROVIDERS],
      exports: [TelescopeService, TELESCOPE_STORAGE],
    };
  }

  static forRootAsync(config: {
    useFactory: (...args: unknown[]) => Promise<TelescopeModuleOptions> | TelescopeModuleOptions;
    inject?: unknown[];
    imports?: DynamicModule['imports'];
  }): DynamicModule {
    return {
      module: TelescopeModule,
      ...(config.imports ? { imports: config.imports } : {}),
      controllers: [TelescopeController],
      providers: [
        {
          provide: TELESCOPE_OPTIONS,
          useFactory: config.useFactory,
          inject: (config.inject ?? []) as Provider[],
        },
        ...SHARED_PROVIDERS,
      ],
      exports: [TelescopeService, TELESCOPE_STORAGE],
    };
  }
}
```

> If the e2e test surfaces a wiring detail (e.g. `enableShutdownHooks`, or the
> `TelescopeOptionsFactory` import being unused — remove it if so), resolve it
> minimally and keep the test green. Report any such deviation.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.module.spec`
Expected: PASS (both cases) — boots a real Nest app, records, serves gated API, denies on false authorizer.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/nest/telescope-pruner.service.ts packages/core/src/nest/telescope.module.ts packages/core/src/nest/telescope.module.spec.ts
git commit -m "feat(core): TelescopeModule (forRoot/forRootAsync) + scheduled pruner"
```

---

## Task 8: Barrel + Fastify parity + build verification

**Files:**
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/nest/telescope.fastify.spec.ts`

- [ ] **Step 1: Add the Fastify parity test**

```ts
// packages/core/src/nest/telescope.fastify.spec.ts
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { TelescopeModule } from './telescope.module.js';
import { TelescopeService } from './telescope.service.js';

describe('TelescopeModule (e2e, Fastify)', () => {
  let app: NestFastifyApplication;
  afterEach(async () => { await app?.close(); });

  it('serves the same gated API on the Fastify adapter', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true })],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const service = app.get(TelescopeService);
    service.record({ type: 'request', content: { statusCode: 200 } });
    await service.flush();

    const res = await app.inject({ method: 'GET', url: '/telescope/api/entries' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.length).toBe(1);
  });
});
```

> Add `@nestjs/platform-fastify` to the package's devDependencies for this test.

- [ ] **Step 2: Run it to verify it fails, then (after Step 3) passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.fastify.spec`
Expected: FAIL first (until devDep installed / barrel exported). After install + barrel: PASS — proves controller/guard are platform-agnostic.

- [ ] **Step 3: Extend the barrel**

Add to `packages/core/src/index.ts`:

```ts
export * from './storage/sqlite-storage-provider.js';
export * from './nest/watcher.js';
export * from './nest/telescope.options.js';
export * from './nest/telescope.service.js';
export * from './nest/telescope.guard.js';
export * from './nest/telescope.controller.js';
export * from './nest/telescope-pruner.service.js';
export * from './nest/telescope.module.js';
```

- [ ] **Step 4: Full verification**

Run, all must be clean:
```
pnpm --filter @dudousxd/nestjs-telescope typecheck
pnpm --filter @dudousxd/nestjs-telescope build
pnpm --filter @dudousxd/nestjs-telescope test
pnpm lint
```
Expected: `dist/` emitted; all specs pass (Express + Fastify e2e green); Biome clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/nest/telescope.fastify.spec.ts packages/core/package.json
git commit -m "feat(core): export Nest host + Fastify parity test"
```

---

## After this plan

The host is runnable: import `TelescopeModule.forRoot(...)` and the SQLite-backed,
gated API is live on Express or Fastify, with flush + prune lifecycle. Follow-on plans:

1. **Request + Exception watchers** — the ALS batch lifecycle (open the `http` batch in middleware so it wraps the handler AND the exception filter; record the request entry with final status/duration; `PlatformRequest` adapter normalizes Express/Fastify). This is the subtle platform-parity work.
2. **Job + Mail + Query watchers** — BullMQ + SQS lifecycle; mailer hook; per-ORM query watchers in `-mikro-orm`/`-typeorm`/`-prisma` (also shipping each ORM's `StorageProvider`).
3. **Expanded roster** — HttpClient, Cache, Gate, Dumps, Schedule, Model.
4. **Strategic features** — `-redis` store, `-otel` bridge, `-ui` dashboard, `-pulse` aggregate health, N+1 detector, Horizon-style queue metrics.
