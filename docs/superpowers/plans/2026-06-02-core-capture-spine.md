# Core Capture Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the framework-agnostic heart of `@dudousxd/nestjs-telescope` — the entry model, AsyncLocalStorage correlation, redaction, the storage SPI with an in-memory implementation, the non-blocking backpressure-safe Recorder, taggers, and config resolution — all fully unit-tested with no NestJS dependency.

**Architecture:** Watchers (later plan) hand `RecordInput`s to the `Recorder`. The Recorder enriches each into an `Entry` (batch id from ALS, sequence, instance id, timestamp), runs taggers, redacts, samples, and pushes to a bounded ring buffer that flushes in batches to a `StorageProvider`. The application thread never blocks: `record()` is O(1) and synchronous; all I/O is deferred. Correlation comes from a `Batch` seeded into AsyncLocalStorage by entry-point watchers.

**Tech Stack:** TypeScript (NodeNext, ESM, strict + exactOptionalPropertyTypes), Vitest, Biome (single quotes, semicolons, 100 cols), uuid, zod. No NestJS in this package slice.

**Scope:** This is `packages/core` foundation only. NestJS integration (TelescopeModule, the request/job/exception/mail watchers, HTTP API + guard, pruner, SQLite store) and the ORM/redis/otel/ui packages are separate plans. This plan produces working, independently testable software: a Recorder you can feed inputs and read back correlated, redacted, paginated entries from a store.

**Reference:** `DESIGN.md` (the architectural contract — §2 SPIs, §3 correlation, §4 config). Where this plan and DESIGN.md disagree, DESIGN.md wins; update it.

**Conventions (verified against sibling libs `nestjs-filter`/`nestjs-inertia`):**
- Each source file one responsibility; tests co-located as `*.spec.ts` next to source, run via `pnpm --filter @dudousxd/nestjs-telescope test`.
- ESM + NodeNext means **relative imports include the `.js` extension** (e.g. `import { Entry } from './entry/entry.js'`). Source is `.ts`; the extension in the import is `.js`.
- `noExplicitAny` is an error outside `test/`. Use `unknown` + narrowing.
- `exactOptionalPropertyTypes` is on: optional fields are `key?: T` and must be omitted (not set to `undefined`) when absent.
- Determinism seams: the Recorder takes injected `now`, `random`, and `idFactory` so tests are deterministic. Production wires `Date.now`, `Math.random`, `uuidv7`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/core/src/entry/entry.ts` | `Entry`, `BatchOrigin`, `RecordInput`, `EntryType` constants. |
| `packages/core/src/entry/content.ts` | Type-specific content shapes (request/query/job/exception/mail). |
| `packages/core/src/redaction/redact.ts` | `redact()` deep masker + `DEFAULT_REDACT_KEYS`. |
| `packages/core/src/context/batch.ts` | `Batch` type + `createBatch()`. |
| `packages/core/src/context/telescope-context.ts` | ALS wrapper: `run`, `current`, `nextSequence`. |
| `packages/core/src/storage/storage-provider.ts` | `StorageProvider` interface + `EntryQuery`/`Page`/`TagCount`/`EntryWithBatch`. |
| `packages/core/src/storage/in-memory-storage-provider.ts` | In-memory `StorageProvider` (filter/cursor/prune/tags/batch). |
| `packages/core/src/tagging/tagger.ts` | `Tagger` type, `runTaggers`, built-in taggers. |
| `packages/core/src/recorder/recorder.ts` | Bounded, async, backpressure-safe Recorder. |
| `packages/core/src/config/options.ts` | `TelescopeModuleOptions` types. |
| `packages/core/src/config/resolve-config.ts` | Zod schema + `resolveConfig()`. |
| `packages/core/src/index.ts` | Barrel (replaces the placeholder). |

---

## Task 1: Entry model & content types

**Files:**
- Create: `packages/core/src/entry/entry.ts`, `packages/core/src/entry/content.ts`
- Test: `packages/core/src/entry/entry.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/entry/entry.spec.ts
import { describe, expect, it } from 'vitest';
import { EntryType, isBatchOrigin } from './entry.js';

describe('entry model', () => {
  it('exposes the built-in entry type constants', () => {
    expect(EntryType.Request).toBe('request');
    expect(EntryType.Query).toBe('query');
    expect(EntryType.Job).toBe('job');
    expect(EntryType.Exception).toBe('exception');
    expect(EntryType.Mail).toBe('mail');
  });

  it('recognizes valid batch origins', () => {
    expect(isBatchOrigin('http')).toBe(true);
    expect(isBatchOrigin('queue')).toBe(true);
    expect(isBatchOrigin('nonsense')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- entry.spec`
Expected: FAIL — cannot find module `./entry.js`.

- [ ] **Step 3: Write `entry.ts`**

```ts
// packages/core/src/entry/entry.ts

export const EntryType = {
  Request: 'request',
  Query: 'query',
  Job: 'job',
  Exception: 'exception',
  Mail: 'mail',
} as const;

export type BuiltinEntryType = (typeof EntryType)[keyof typeof EntryType];

const BATCH_ORIGINS = ['http', 'queue', 'schedule', 'cli', 'manual'] as const;
export type BatchOrigin = (typeof BATCH_ORIGINS)[number];

export function isBatchOrigin(value: unknown): value is BatchOrigin {
  return typeof value === 'string' && (BATCH_ORIGINS as readonly string[]).includes(value);
}

/** A captured, persisted record. `content` is type-specific (see content.ts). */
export interface Entry<TContent = unknown> {
  id: string;
  batchId: string;
  type: string;
  familyHash: string | null;
  content: TContent;
  tags: string[];
  sequence: number;
  durationMs: number | null;
  origin: BatchOrigin;
  instanceId: string;
  createdAt: Date;
}

/** What a watcher hands to the Recorder. Everything else is filled in by enrichment. */
export interface RecordInput<TContent = unknown> {
  type: string;
  content: TContent;
  familyHash?: string | null;
  tags?: string[];
  durationMs?: number | null;
  startedAt?: Date;
}
```

- [ ] **Step 4: Write `content.ts`**

```ts
// packages/core/src/entry/content.ts

export interface RequestContent {
  method: string;
  uri: string;
  headers: Record<string, unknown>;
  payload: unknown;
  response: unknown;
  statusCode: number | null;
  ip: string | null;
  memoryMb: number | null;
}

export interface QueryContent {
  sql: string;
  bindings: unknown[];
  connection: string | null;
  slow: boolean;
}

export interface JobContent {
  name: string;
  queue: string;
  payload: unknown;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempts: number;
  failureReason: string | null;
}

export interface ExceptionContent {
  class: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown>;
}

export interface MailContent {
  mailer: string;
  from: string | null;
  to: string[];
  subject: string | null;
  preview: string | null;
  status: 'sent' | 'failed';
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- entry.spec`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/entry
git commit -m "feat(core): entry model and content types"
```

---

## Task 2: Redaction

Deep-masks sensitive values before anything is persisted. Always applies a default
key denylist (case-insensitive), merged with caller-supplied keys and explicit paths.

**Files:**
- Create: `packages/core/src/redaction/redact.ts`
- Test: `packages/core/src/redaction/redact.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/redaction/redact.spec.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACT_KEYS, redact } from './redact.js';

describe('redact', () => {
  it('masks default-sensitive keys case-insensitively at any depth', () => {
    const input = { user: { Password: 'p', token: 't', name: 'davi' }, ok: 1 };
    const out = redact(input, {}) as Record<string, any>;
    expect(out.user.Password).toBe('[REDACTED]');
    expect(out.user.token).toBe('[REDACTED]');
    expect(out.user.name).toBe('davi');
    expect(out.ok).toBe(1);
  });

  it('does not mutate the input', () => {
    const input = { password: 'secret' };
    redact(input, {});
    expect(input.password).toBe('secret');
  });

  it('masks caller-specified extra keys and dot-paths', () => {
    const input = { headers: { 'x-api-key': 'k' }, body: { ssn: '123' } };
    const out = redact(input, { keys: ['x-api-key'], paths: ['body.ssn'] }) as Record<string, any>;
    expect(out.headers['x-api-key']).toBe('[REDACTED]');
    expect(out.body.ssn).toBe('[REDACTED]');
  });

  it('handles arrays and leaves primitives/null alone', () => {
    expect(redact(null, {})).toBeNull();
    expect(redact(5, {})).toBe(5);
    const out = redact([{ password: 'x' }, { keep: 1 }], {}) as any[];
    expect(out[0].password).toBe('[REDACTED]');
    expect(out[1].keep).toBe(1);
  });

  it('includes the documented default keys', () => {
    expect(DEFAULT_REDACT_KEYS).toContain('authorization');
    expect(DEFAULT_REDACT_KEYS).toContain('password');
    expect(DEFAULT_REDACT_KEYS).toContain('secret');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- redact.spec`
Expected: FAIL — cannot find module `./redact.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/redaction/redact.ts

export const DEFAULT_REDACT_KEYS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'api-key',
  'api_key',
  'apikey',
  'x-api-key',
  'client_secret',
  'private_key',
];

export interface RedactOptions {
  /** Extra keys to mask (merged with DEFAULT_REDACT_KEYS, case-insensitive). */
  keys?: string[];
  /** Exact dot-paths to mask regardless of key name, e.g. 'body.ssn'. */
  paths?: string[];
  /** Replacement string. Defaults to '[REDACTED]'. */
  mask?: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Returns a deep clone of `value` with sensitive leaves replaced by the mask.
 * Never mutates the input.
 */
export function redact(value: unknown, options: RedactOptions): unknown {
  const mask = options.mask ?? '[REDACTED]';
  const keySet = new Set(
    [...DEFAULT_REDACT_KEYS, ...(options.keys ?? [])].map((key) => key.toLowerCase()),
  );
  const paths = new Set(options.paths ?? []);

  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, path ? `${path}.${index}` : String(index)));
    }
    if (isPlainObject(node)) {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        const childPath = path ? `${path}.${key}` : key;
        if (keySet.has(key.toLowerCase()) || paths.has(childPath)) {
          result[key] = mask;
        } else {
          result[key] = walk(child, childPath);
        }
      }
      return result;
    }
    return node;
  };

  return walk(value, '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- redact.spec`
Expected: PASS (all five cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/redaction
git commit -m "feat(core): deep redaction with default sensitive-key denylist"
```

---

## Task 3: Batch + AsyncLocalStorage context

Correlation: an entry-point watcher runs work inside `context.run(batch, fn)`;
every `record()` inside that async flow reads the same `Batch` and a monotonic
sequence.

**Files:**
- Create: `packages/core/src/context/batch.ts`, `packages/core/src/context/telescope-context.ts`
- Test: `packages/core/src/context/telescope-context.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/context/telescope-context.spec.ts
import { describe, expect, it } from 'vitest';
import { createBatch } from './batch.js';
import { TelescopeContext } from './telescope-context.js';

describe('TelescopeContext', () => {
  it('exposes the active batch only inside run()', async () => {
    const ctx = new TelescopeContext();
    expect(ctx.current()).toBeUndefined();

    const batch = createBatch('http', () => 'batch-1');
    await ctx.run(batch, async () => {
      expect(ctx.current()?.id).toBe('batch-1');
    });

    expect(ctx.current()).toBeUndefined();
  });

  it('hands out monotonic sequence numbers within a batch', async () => {
    const ctx = new TelescopeContext();
    const batch = createBatch('queue', () => 'b');
    await ctx.run(batch, async () => {
      expect(ctx.nextSequence()).toBe(0);
      expect(ctx.nextSequence()).toBe(1);
      expect(ctx.nextSequence()).toBe(2);
    });
  });

  it('isolates sequences across concurrent batches', async () => {
    const ctx = new TelescopeContext();
    const a = ctx.run(createBatch('http', () => 'a'), async () => {
      await Promise.resolve();
      return ctx.nextSequence();
    });
    const b = ctx.run(createBatch('http', () => 'b'), async () => ctx.nextSequence());
    expect(await Promise.all([a, b])).toEqual([0, 0]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope-context.spec`
Expected: FAIL — cannot find module `./batch.js`.

- [ ] **Step 3: Write `batch.ts`**

```ts
// packages/core/src/context/batch.ts
import type { BatchOrigin } from '../entry/entry.js';

export interface Batch {
  id: string;
  origin: BatchOrigin;
  startedAt: Date;
  traceId?: string;
  spanId?: string;
}

/** Internal: mutable per-batch state held in the ALS store. */
export interface BatchState {
  batch: Batch;
  sequence: number;
}

export function createBatch(
  origin: BatchOrigin,
  idFactory: () => string,
  now: () => number = Date.now,
): Batch {
  return { id: idFactory(), origin, startedAt: new Date(now()) };
}
```

- [ ] **Step 4: Write `telescope-context.ts`**

```ts
// packages/core/src/context/telescope-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Batch, BatchState } from './batch.js';

export class TelescopeContext {
  private readonly als = new AsyncLocalStorage<BatchState>();

  run<T>(batch: Batch, fn: () => Promise<T>): Promise<T> {
    return this.als.run({ batch, sequence: 0 }, fn);
  }

  current(): Batch | undefined {
    return this.als.getStore()?.batch;
  }

  /** Next capture-order index within the active batch; 0 outside any batch. */
  nextSequence(): number {
    const state = this.als.getStore();
    if (!state) {
      return 0;
    }
    const next = state.sequence;
    state.sequence += 1;
    return next;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope-context.spec`
Expected: PASS (all three cases).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/context
git commit -m "feat(core): AsyncLocalStorage batch correlation context"
```

---

## Task 4: StorageProvider SPI + in-memory implementation

**Files:**
- Create: `packages/core/src/storage/storage-provider.ts`, `packages/core/src/storage/in-memory-storage-provider.ts`
- Test: `packages/core/src/storage/in-memory-storage-provider.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/storage/in-memory-storage-provider.spec.ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from './in-memory-storage-provider.js';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'id',
    batchId: 'b',
    type: 'request',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('InMemoryStorageProvider', () => {
  it('stores and finds an entry with its batch', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([
      entry({ id: '1', batchId: 'b', sequence: 0 }),
      entry({ id: '2', batchId: 'b', type: 'query', sequence: 1 }),
    ]);
    const found = await store.find('1');
    expect(found?.id).toBe('1');
    expect(found?.batch.map((event) => event.id)).toEqual(['1', '2']);
  });

  it('filters by type and tag', async () => {
    const store = new InMemoryStorageProvider();
    await store.store([
      entry({ id: '1', type: 'request', tags: ['status:200'] }),
      entry({ id: '2', type: 'query', tags: ['slow'] }),
    ]);
    expect((await store.get({ type: 'query' })).data.map((e) => e.id)).toEqual(['2']);
    expect((await store.get({ tag: 'slow' })).data.map((e) => e.id)).toEqual(['2']);
  });

  it('paginates newest-first with a cursor', async () => {
    const store = new InMemoryStorageProvider();
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
    const store = new InMemoryStorageProvider();
    await store.store([
      entry({ id: '1', tags: ['slow'], createdAt: new Date('2026-01-01T00:00:00Z') }),
      entry({ id: '2', tags: ['slow'], createdAt: new Date('2026-02-01T00:00:00Z') }),
    ]);
    expect(await store.tags()).toContainEqual({ tag: 'slow', count: 2 });
    const removed = await store.prune(new Date('2026-01-15T00:00:00Z'));
    expect(removed).toBe(1);
    expect((await store.get({})).data.map((e) => e.id)).toEqual(['2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- in-memory-storage-provider.spec`
Expected: FAIL — cannot find module `./in-memory-storage-provider.js`.

- [ ] **Step 3: Write `storage-provider.ts`**

```ts
// packages/core/src/storage/storage-provider.ts
import type { Entry } from '../entry/entry.js';

export interface EntryQuery {
  type?: string;
  tag?: string;
  familyHash?: string;
  batchId?: string;
  before?: Date;
  after?: Date;
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface EntryWithBatch extends Entry {
  batch: Entry[];
}

export interface StorageProvider {
  store(entries: Entry[]): Promise<void>;
  update(id: string, patch: Partial<Entry>): Promise<void>;
  find(id: string): Promise<EntryWithBatch | null>;
  get(query: EntryQuery): Promise<Page<Entry>>;
  batch(batchId: string): Promise<Entry[]>;
  tags(prefix?: string): Promise<TagCount[]>;
  prune(olderThan: Date, keepLast?: number): Promise<number>;
  clear(): Promise<void>;
}
```

- [ ] **Step 4: Write `in-memory-storage-provider.ts`**

```ts
// packages/core/src/storage/in-memory-storage-provider.ts
import type { Entry } from '../entry/entry.js';
import type {
  EntryQuery,
  EntryWithBatch,
  Page,
  StorageProvider,
  TagCount,
} from './storage-provider.js';

const DEFAULT_LIMIT = 50;

/**
 * Process-local store. Used as a test double and as a zero-dependency option
 * for single-instance/serverless setups. Newest-first ordering by createdAt
 * then id; cursor is the last seen entry id (keyset pagination).
 */
export class InMemoryStorageProvider implements StorageProvider {
  private entries: Entry[] = [];

  async store(entries: Entry[]): Promise<void> {
    this.entries.push(...entries);
  }

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index !== -1) {
      const existing = this.entries[index];
      if (existing) {
        this.entries[index] = { ...existing, ...patch, id: existing.id };
      }
    }
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      return null;
    }
    return { ...entry, batch: await this.batch(entry.batchId) };
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    const ordered = [...this.entries]
      .filter((entry) => this.matches(entry, query))
      .sort(this.newestFirst);

    let start = 0;
    if (query.cursor) {
      const cursorIndex = ordered.findIndex((entry) => entry.id === query.cursor);
      start = cursorIndex === -1 ? ordered.length : cursorIndex + 1;
    }

    const limit = query.limit ?? DEFAULT_LIMIT;
    const slice = ordered.slice(start, start + limit);
    const last = slice.at(-1);
    const hasMore = last ? start + limit < ordered.length : false;
    return { data: slice, nextCursor: hasMore && last ? last.id : null };
  }

  async batch(batchId: string): Promise<Entry[]> {
    return this.entries
      .filter((entry) => entry.batchId === batchId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async tags(prefix?: string): Promise<TagCount[]> {
    const counts = new Map<string, number>();
    for (const entry of this.entries) {
      for (const tag of entry.tags) {
        if (!prefix || tag.startsWith(prefix)) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count }));
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    const before = this.entries.length;
    let survivors = this.entries.filter((entry) => entry.createdAt >= olderThan);
    if (keepLast !== undefined && survivors.length < this.entries.length) {
      const pruned = [...this.entries]
        .filter((entry) => entry.createdAt < olderThan)
        .sort(this.newestFirst)
        .slice(0, keepLast);
      survivors = [...survivors, ...pruned];
    }
    this.entries = survivors;
    return before - this.entries.length;
  }

  async clear(): Promise<void> {
    this.entries = [];
  }

  private matches(entry: Entry, query: EntryQuery): boolean {
    if (query.type && entry.type !== query.type) return false;
    if (query.tag && !entry.tags.includes(query.tag)) return false;
    if (query.familyHash && entry.familyHash !== query.familyHash) return false;
    if (query.batchId && entry.batchId !== query.batchId) return false;
    if (query.before && entry.createdAt >= query.before) return false;
    if (query.after && entry.createdAt <= query.after) return false;
    return true;
  }

  private newestFirst = (a: Entry, b: Entry): number => {
    const delta = b.createdAt.getTime() - a.createdAt.getTime();
    return delta !== 0 ? delta : b.id.localeCompare(a.id);
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- in-memory-storage-provider.spec`
Expected: PASS (all four cases).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/storage
git commit -m "feat(core): storage SPI and in-memory provider"
```

---

## Task 5: Taggers

**Files:**
- Create: `packages/core/src/tagging/tagger.ts`
- Test: `packages/core/src/tagging/tagger.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/tagging/tagger.spec.ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { runTaggers, slowTagger, statusTagger } from './tagger.js';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'id', batchId: 'b', type: 'request', familyHash: null, content: {},
    tags: [], sequence: 0, durationMs: null, origin: 'http', instanceId: 'i',
    createdAt: new Date(), ...over,
  };
}

describe('taggers', () => {
  it('statusTagger tags request entries with their status code', () => {
    const tags = statusTagger(entry({ type: 'request', content: { statusCode: 500 } }));
    expect(tags).toEqual(['status:500']);
  });

  it('slowTagger flags entries over the threshold', () => {
    expect(slowTagger(entry({ durationMs: 1500 }))).toEqual(['slow']);
    expect(slowTagger(entry({ durationMs: 5 }))).toEqual([]);
  });

  it('runTaggers concatenates and de-duplicates tags onto existing ones', () => {
    const result = runTaggers(
      entry({ tags: ['keep'], durationMs: 2000, content: { statusCode: 500 } }),
      [statusTagger, slowTagger, () => ['keep']],
    );
    expect(result).toEqual(['keep', 'status:500', 'slow']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- tagger.spec`
Expected: FAIL — cannot find module `./tagger.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/tagging/tagger.ts
import type { Entry } from '../entry/entry.js';

export type Tagger = (entry: Entry) => string[];

/** Default threshold (ms) above which an entry is tagged 'slow'. */
export const SLOW_THRESHOLD_MS = 1000;

export const statusTagger: Tagger = (entry) => {
  const status = (entry.content as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? [`status:${status}`] : [];
};

export const slowTagger: Tagger = (entry) =>
  entry.durationMs !== null && entry.durationMs >= SLOW_THRESHOLD_MS ? ['slow'] : [];

export const BUILTIN_TAGGERS: Tagger[] = [statusTagger, slowTagger];

/** Returns the entry's existing tags plus all tagger outputs, de-duplicated, order-preserving. */
export function runTaggers(entry: Entry, taggers: Tagger[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (tag: string): void => {
    if (!seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  };
  for (const tag of entry.tags) add(tag);
  for (const tagger of taggers) {
    for (const tag of tagger(entry)) add(tag);
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- tagger.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tagging
git commit -m "feat(core): tagger pipeline and built-in taggers"
```

---

## Task 6: Recorder (bounded, non-blocking, backpressure-safe)

The centerpiece. `record()` is synchronous and O(1): it enriches the input into an
`Entry` (batch id + sequence from context, instance id, timestamp), runs taggers,
redacts content, applies sampling, and pushes onto a bounded ring buffer. A timer
flushes batches to storage. On overflow the oldest entry is dropped and a counter
incremented — never blocks, never grows unbounded.

**Files:**
- Create: `packages/core/src/recorder/recorder.ts`
- Test: `packages/core/src/recorder/recorder.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/recorder/recorder.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { TelescopeContext } from '../context/telescope-context.js';
import { createBatch } from '../context/batch.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { Recorder } from './recorder.js';

function makeRecorder(over: Partial<ConstructorParameters<typeof Recorder>[0]> = {}) {
  const storage = new InMemoryStorageProvider();
  const context = new TelescopeContext();
  let counter = 0;
  const recorder = new Recorder({
    storage,
    context,
    instanceId: 'pod-1',
    taggers: [],
    redact: {},
    sampling: {},
    bufferSize: 100,
    now: () => 1_000,
    random: () => 0,
    idFactory: () => `id-${counter++}`,
    ...over,
  });
  return { recorder, storage, context };
}

describe('Recorder', () => {
  it('enriches an input into an entry with batch id, sequence, instance id', async () => {
    const { recorder, storage, context } = makeRecorder();
    await context.run(createBatch('http', () => 'batch-1', () => 1_000), async () => {
      recorder.record({ type: 'request', content: { statusCode: 200 } });
    });
    await recorder.flush();

    const page = await storage.get({});
    expect(page.data).toHaveLength(1);
    const entry = page.data[0]!;
    expect(entry.batchId).toBe('batch-1');
    expect(entry.sequence).toBe(0);
    expect(entry.instanceId).toBe('pod-1');
    expect(entry.origin).toBe('http');
    expect(entry.createdAt).toEqual(new Date(1_000));
  });

  it('redacts content and applies taggers before storing', async () => {
    const { recorder, storage } = makeRecorder({
      taggers: [(e) => [`type:${e.type}`]],
    });
    recorder.record({ type: 'request', content: { password: 'secret', statusCode: 200 } });
    await recorder.flush();

    const entry = (await storage.get({})).data[0]!;
    expect((entry.content as any).password).toBe('[REDACTED]');
    expect(entry.tags).toContain('type:request');
  });

  it('gives entries outside any batch a synthetic batch id', async () => {
    const { recorder, storage } = makeRecorder();
    recorder.record({ type: 'exception', content: {} });
    await recorder.flush();
    expect((await storage.get({})).data[0]!.batchId).toBe('id-0');
  });

  it('drops by sampling rate without blocking', async () => {
    const { recorder, storage } = makeRecorder({ sampling: { query: 0 }, random: () => 0.5 });
    recorder.record({ type: 'query', content: {} });
    await recorder.flush();
    expect((await storage.get({})).data).toHaveLength(0);
  });

  it('drops oldest and counts when the buffer overflows', async () => {
    const { recorder, storage } = makeRecorder({ bufferSize: 2 });
    recorder.record({ type: 'request', content: { n: 1 } });
    recorder.record({ type: 'request', content: { n: 2 } });
    recorder.record({ type: 'request', content: { n: 3 } });
    expect(recorder.droppedCount).toBe(1);
    await recorder.flush();
    const stored = (await storage.get({})).data.map((e) => (e.content as any).n).sort();
    expect(stored).toEqual([2, 3]);
  });

  it('flush is a no-op when the buffer is empty', async () => {
    const { recorder } = makeRecorder();
    await expect(recorder.flush()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- recorder.spec`
Expected: FAIL — cannot find module `./recorder.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/recorder/recorder.ts
import type { Entry, RecordInput } from '../entry/entry.js';
import type { TelescopeContext } from '../context/telescope-context.js';
import type { RedactOptions } from '../redaction/redact.js';
import { redact } from '../redaction/redact.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { Tagger } from '../tagging/tagger.js';
import { runTaggers } from '../tagging/tagger.js';

export interface RecorderOptions {
  storage: StorageProvider;
  context: TelescopeContext;
  instanceId: string;
  taggers: Tagger[];
  redact: RedactOptions;
  /** Per-type keep-rate 0..1. Missing type ⇒ keep (rate 1). */
  sampling: Record<string, number>;
  bufferSize: number;
  now?: () => number;
  random?: () => number;
  idFactory: () => string;
}

export class Recorder {
  private readonly buffer: Entry[] = [];
  private readonly now: () => number;
  private readonly random: () => number;
  private dropped = 0;

  constructor(private readonly options: RecorderOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  /** Synchronous, O(1), never throws into the caller. */
  record(input: RecordInput): void {
    try {
      if (!this.passesSampling(input.type)) {
        return;
      }
      this.push(this.enrich(input));
    } catch {
      // A telescope bug must never break the host. Swallow.
      this.dropped += 1;
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }
    const drained = this.buffer.splice(0, this.buffer.length);
    try {
      await this.options.storage.store(drained);
    } catch {
      // Drop on storage failure rather than block or grow.
      this.dropped += drained.length;
    }
  }

  private passesSampling(type: string): boolean {
    const rate = this.options.sampling[type];
    if (rate === undefined || rate >= 1) {
      return true;
    }
    if (rate <= 0) {
      return false;
    }
    return this.random() < rate;
  }

  private enrich(input: RecordInput): Entry {
    const batch = this.options.context.current();
    // Resolve the batch id first so an out-of-batch entry's synthetic batch id
    // is the first generated id (keeps id allocation order predictable).
    const batchId = batch?.id ?? this.options.idFactory();
    const base: Entry = {
      id: this.options.idFactory(),
      batchId,
      type: input.type,
      familyHash: input.familyHash ?? null,
      content: redact(input.content, this.options.redact),
      tags: input.tags ?? [],
      sequence: this.options.context.nextSequence(),
      durationMs: input.durationMs ?? null,
      origin: batch?.origin ?? 'manual',
      instanceId: this.options.instanceId,
      createdAt: new Date(this.now()),
    };
    return { ...base, tags: runTaggers(base, this.options.taggers) };
  }

  private push(entry: Entry): void {
    if (this.buffer.length >= this.options.bufferSize) {
      this.buffer.shift();
      this.dropped += 1;
    }
    this.buffer.push(entry);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- recorder.spec`
Expected: PASS (all six cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/recorder
git commit -m "feat(core): non-blocking backpressure-safe Recorder"
```

---

## Task 7: Config types + resolution

Validates `TelescopeModuleOptions` and resolves defaults. Watcher/storage/authorizer
values are opaque pass-throughs (validated where they're consumed, in the Nest plan);
this task owns the framework-agnostic shape: redaction, sampling, recorder, prune,
taggers, instanceId.

**Files:**
- Create: `packages/core/src/config/options.ts`, `packages/core/src/config/resolve-config.ts`
- Test: `packages/core/src/config/resolve-config.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/config/resolve-config.spec.ts
import { describe, expect, it } from 'vitest';
import { resolveConfig } from './resolve-config.js';

describe('resolveConfig', () => {
  it('fills defaults when given an empty object', () => {
    const config = resolveConfig({});
    expect(config.enabled).toBe(true);
    expect(config.recorder.bufferSize).toBeGreaterThan(0);
    expect(config.sampling).toEqual({});
    expect(typeof config.instanceId).toBe('string');
  });

  it('normalizes a global sampling number into a default rate', () => {
    const config = resolveConfig({ sampling: 0.5 });
    expect(config.sampling).toEqual({ default: 0.5 });
  });

  it('parses a string prune duration into milliseconds', () => {
    const config = resolveConfig({ prune: { after: '24h' } });
    expect(config.prune?.afterMs).toBe(24 * 60 * 60 * 1000);
  });

  it('rejects an out-of-range sampling rate', () => {
    expect(() => resolveConfig({ sampling: 2 })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- resolve-config.spec`
Expected: FAIL — cannot find module `./resolve-config.js`.

- [ ] **Step 3: Write `options.ts`**

```ts
// packages/core/src/config/options.ts
import type { Entry } from '../entry/entry.js';
import type { RedactOptions } from '../redaction/redact.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { Tagger } from '../tagging/tagger.js';

export type Duration = number | string;

export interface PruneOptions {
  after: Duration;
  keepLast?: number;
  intervalMs?: number;
}

export interface RecorderTuning {
  bufferSize?: number;
  flushIntervalMs?: number;
  flushBatchSize?: number;
}

/** Author-facing options. NestJS-specific fields (watchers, authorizer, path) are
 *  layered on in the Nest integration package; this shape is the agnostic subset. */
export interface TelescopeCoreOptions {
  enabled?: boolean;
  storage?: StorageProvider;
  redact?: RedactOptions;
  sampling?: number | Record<string, number>;
  recorder?: RecorderTuning;
  prune?: PruneOptions;
  taggers?: Tagger[];
  instanceId?: string;
  filter?: (entry: Entry) => boolean;
}

export interface ResolvedCoreConfig {
  enabled: boolean;
  redact: RedactOptions;
  sampling: Record<string, number>;
  recorder: Required<RecorderTuning>;
  prune?: { afterMs: number; keepLast?: number; intervalMs: number };
  taggers: Tagger[];
  instanceId: string;
  filter?: (entry: Entry) => boolean;
}
```

- [ ] **Step 4: Write `resolve-config.ts`**

```ts
// packages/core/src/config/resolve-config.ts
import { hostname } from 'node:os';
import { z } from 'zod';
import { BUILTIN_TAGGERS } from '../tagging/tagger.js';
import type { ResolvedCoreConfig, TelescopeCoreOptions } from './options.js';

const RATE = z.number().min(0).max(1);

const optionsSchema = z.object({
  enabled: z.boolean().default(true),
  sampling: z.union([RATE, z.record(RATE)]).optional(),
  recorder: z
    .object({
      bufferSize: z.number().int().positive().default(10_000),
      flushIntervalMs: z.number().int().positive().default(1_000),
      flushBatchSize: z.number().int().positive().default(500),
    })
    .default({}),
  prune: z
    .object({
      after: z.union([z.number(), z.string()]),
      keepLast: z.number().int().nonnegative().optional(),
      intervalMs: z.number().int().positive().default(60_000),
    })
    .optional(),
  instanceId: z.string().optional(),
});

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function toMs(duration: number | string): number {
  if (typeof duration === 'number') {
    return duration;
  }
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration.trim());
  if (!match) {
    throw new Error(`Invalid duration: ${duration}`);
  }
  return Number(match[1]) * DURATION_UNITS[match[2] as keyof typeof DURATION_UNITS]!;
}

function normalizeSampling(sampling: number | Record<string, number> | undefined): Record<string, number> {
  if (sampling === undefined) return {};
  return typeof sampling === 'number' ? { default: sampling } : sampling;
}

export function resolveConfig(options: TelescopeCoreOptions): ResolvedCoreConfig {
  const parsed = optionsSchema.parse(options);
  const resolved: ResolvedCoreConfig = {
    enabled: parsed.enabled,
    redact: options.redact ?? {},
    sampling: normalizeSampling(parsed.sampling),
    recorder: parsed.recorder as Required<typeof parsed.recorder>,
    taggers: [...BUILTIN_TAGGERS, ...(options.taggers ?? [])],
    instanceId: parsed.instanceId ?? hostname(),
  };
  if (parsed.prune) {
    resolved.prune = {
      afterMs: toMs(parsed.prune.after),
      intervalMs: parsed.prune.intervalMs,
      ...(parsed.prune.keepLast !== undefined ? { keepLast: parsed.prune.keepLast } : {}),
    };
  }
  if (options.filter) {
    resolved.filter = options.filter;
  }
  return resolved;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- resolve-config.spec`
Expected: PASS (all four cases).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config
git commit -m "feat(core): config types and zod-validated resolution"
```

---

## Task 8: Barrel export + package build verification

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Replace the placeholder barrel**

```ts
// packages/core/src/index.ts
export * from './entry/entry.js';
export * from './entry/content.js';
export * from './redaction/redact.js';
export * from './context/batch.js';
export * from './context/telescope-context.js';
export * from './storage/storage-provider.js';
export * from './storage/in-memory-storage-provider.js';
export * from './tagging/tagger.js';
export * from './recorder/recorder.js';
export * from './config/options.js';
export * from './config/resolve-config.js';

export const TELESCOPE_VERSION = '0.0.0';
```

- [ ] **Step 2: Typecheck the package**

Run: `pnpm --filter @dudousxd/nestjs-telescope typecheck`
Expected: no errors.

- [ ] **Step 3: Build the package**

Run: `pnpm --filter @dudousxd/nestjs-telescope build`
Expected: `dist/` emitted, no errors.

- [ ] **Step 4: Full test + lint**

Run: `pnpm --filter @dudousxd/nestjs-telescope test && pnpm lint`
Expected: all specs pass; Biome clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): public barrel for the capture spine"
```

---

## After this plan

The capture spine is complete and unit-tested. Follow-up plans (each its own document):

1. **NestJS integration** — `TelescopeModule.forRoot/forRootAsync`, `TelescopeService` (owns recorder + storage + context + flush timer + `onApplicationShutdown` drain + scheduled pruner), the **RequestWatcher** (interceptor, opens the `http` batch), **ExceptionWatcher**, **JobWatcher** (BullMQ + SQS), **MailWatcher**, the headless HTTP API + `TelescopeGuard` (default-deny in prod), and the default **SQLite store** (`better-sqlite3`).
2. **ORM adapters** — `-mikro-orm`, `-typeorm`, `-prisma`: each a QueryWatcher + StorageProvider.
3. **`-redis` store** — shared, TTL-pruned, multi-instance.
4. **`-otel`** — bidirectional bridge.
5. **`-ui`** — dashboard SPA over the headless API.
6. **`-testing`** — re-export `InMemoryStorageProvider` + a watcher test harness + fake clock.
