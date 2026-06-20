// packages/mikro-orm-watcher/src/mikro-orm-lifecycle.watcher.integration.spec.ts
//
// Integration: real MikroORM sqlite ORM (:memory:) + the MikroOrmModelWatcher.
// Validates that flush and transaction lifecycle events are captured as `model`
// entries with the correct kind discriminator and a non-null durationMs.
//
import 'reflect-metadata';
import type {
  BatchHandle,
  BatchOrigin,
  RecordInput,
  WatcherContext,
} from '@dudousxd/nestjs-telescope';
import { resolveConfig } from '@dudousxd/nestjs-telescope';
import { EntitySchema, MikroORM } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FlushEntryContent, TransactionEntryContent } from './mikro-orm-model.watcher.js';
import { MikroOrmModelWatcher } from './mikro-orm-model.watcher.js';

interface BookShape {
  id: number;
  title: string;
}

const Book = new EntitySchema<BookShape>({
  name: 'Book',
  tableName: 'book',
  properties: {
    id: { type: 'integer', primary: true },
    title: { type: 'string' },
  },
});

/** Build a WatcherContext whose moduleRef resolves the given ORM (or nothing). */
function makeCtx(resolved: unknown): { ctx: WatcherContext; recorded: RecordInput[] } {
  const recorded: RecordInput[] = [];
  const ctx: WatcherContext = {
    record: (input) => {
      recorded.push(input);
    },
    runInBatch: async <T>(_origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => fn(),
    beginBatch: (): BatchHandle => ({ id: 'batch', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: {
      get: () => {
        if (resolved === undefined) throw new Error('not found');
        return resolved;
      },
    } as unknown as WatcherContext['moduleRef'],
  };
  return { ctx, recorded };
}

describe('MikroOrmModelWatcher — flush lifecycle', () => {
  let orm: MikroORM;
  let recorded: RecordInput[];

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Book],
      allowGlobalContext: true,
    });
    await orm.schema.create();

    const { ctx, recorded: rec } = makeCtx(orm);
    recorded = rec;
    new MikroOrmModelWatcher().register(ctx);
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it('records a flush entry with kind "flush" after em.flush()', async () => {
    recorded.length = 0;
    const em = orm.em.fork();
    em.create<BookShape>(Book, { id: 10, title: 'Test Book' });
    await em.flush();

    const flushEntries = recorded.filter((e) => (e.content as { kind: string }).kind === 'flush');
    expect(flushEntries.length).toBeGreaterThan(0);

    const entry = flushEntries[0]!;
    expect(entry.type).toBe('model');
    expect(entry.tags).toContain('model:flush');

    const content = entry.content as FlushEntryContent;
    expect(content.kind).toBe('flush');
  });

  it('records flush entry with a numeric durationMs >= 0', async () => {
    recorded.length = 0;
    const em = orm.em.fork();
    em.create<BookShape>(Book, { id: 11, title: 'Another Book' });
    await em.flush();

    const flushEntry = recorded.find((e) => (e.content as { kind: string }).kind === 'flush');
    expect(flushEntry).toBeDefined();
    expect(typeof flushEntry!.durationMs).toBe('number');
    expect(flushEntry!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records flush entry with familyHash "model:flush"', async () => {
    recorded.length = 0;
    const em = orm.em.fork();
    em.create<BookShape>(Book, { id: 12, title: 'Book 12' });
    await em.flush();

    const flushEntry = recorded.find((e) => (e.content as { kind: string }).kind === 'flush');
    expect(flushEntry?.familyHash).toBe('model:flush');
  });
});

describe('MikroOrmModelWatcher — transaction lifecycle', () => {
  let orm: MikroORM;
  let recorded: RecordInput[];

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Book],
      allowGlobalContext: true,
    });
    await orm.schema.create();

    const { ctx, recorded: rec } = makeCtx(orm);
    recorded = rec;
    new MikroOrmModelWatcher().register(ctx);
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it('records a transaction entry with outcome "committed" after a successful transaction', async () => {
    recorded.length = 0;
    await orm.em.transactional(async (em) => {
      em.create<BookShape>(Book, { id: 100, title: 'Txn Book' });
    });

    const txEntries = recorded.filter(
      (e) => (e.content as { kind: string }).kind === 'transaction',
    );
    expect(txEntries.length).toBeGreaterThan(0);

    const content = txEntries[0]!.content as TransactionEntryContent;
    expect(content.kind).toBe('transaction');
    expect(content.outcome).toBe('committed');
  });

  it('records a transaction entry with durationMs >= 0', async () => {
    recorded.length = 0;
    await orm.em.transactional(async (em) => {
      em.create<BookShape>(Book, { id: 101, title: 'Txn Book 2' });
    });

    const txEntry = recorded.find((e) => (e.content as { kind: string }).kind === 'transaction');
    expect(txEntry).toBeDefined();
    expect(typeof txEntry!.durationMs).toBe('number');
    expect(txEntry!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a transaction entry with outcome "rolled-back" after a rollback', async () => {
    recorded.length = 0;
    try {
      await orm.em.transactional(async (em) => {
        em.create<BookShape>(Book, { id: 200, title: 'Will Rollback' });
        throw new Error('forced rollback');
      });
    } catch {
      // expected
    }

    const txEntries = recorded.filter(
      (e) => (e.content as { kind: string }).kind === 'transaction',
    );
    expect(txEntries.length).toBeGreaterThan(0);

    const content = txEntries[0]!.content as TransactionEntryContent;
    expect(content.kind).toBe('transaction');
    expect(content.outcome).toBe('rolled-back');
  });

  it('records transaction entry with correct familyHash for committed', async () => {
    recorded.length = 0;
    await orm.em.transactional(async (em) => {
      em.create<BookShape>(Book, { id: 300, title: 'Hash Book' });
    });

    const txEntry = recorded.find(
      (e) =>
        (e.content as { kind: string; outcome: string }).kind === 'transaction' &&
        (e.content as { kind: string; outcome: string }).outcome === 'committed',
    );
    expect(txEntry?.familyHash).toBe('model:transaction:committed');
    expect(txEntry?.tags).toContain('transaction:committed');
  });

  it('records transaction entry with correct familyHash for rolled-back', async () => {
    recorded.length = 0;
    try {
      await orm.em.transactional(async () => {
        throw new Error('forced rollback');
      });
    } catch {
      // expected
    }

    const txEntry = recorded.find(
      (e) =>
        (e.content as { kind: string; outcome: string }).kind === 'transaction' &&
        (e.content as { kind: string; outcome: string }).outcome === 'rolled-back',
    );
    expect(txEntry?.familyHash).toBe('model:transaction:rolled-back');
    expect(txEntry?.tags).toContain('transaction:rolled-back');
  });
});

describe('MikroOrmModelWatcher — entity entries still carry kind "entity"', () => {
  let orm: MikroORM;
  let recorded: RecordInput[];

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Book],
      allowGlobalContext: true,
    });
    await orm.schema.create();

    const { ctx, recorded: rec } = makeCtx(orm);
    recorded = rec;
    new MikroOrmModelWatcher().register(ctx);
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it('entity entries have kind "entity"', async () => {
    recorded.length = 0;
    const em = orm.em.fork();
    em.create<BookShape>(Book, { id: 50, title: 'Kind Test' });
    await em.flush();

    const entityEntries = recorded.filter((e) => (e.content as { kind: string }).kind === 'entity');
    expect(entityEntries.length).toBeGreaterThan(0);

    const content = entityEntries[0]!.content as {
      kind: string;
      action: string;
      entity: string;
    };
    expect(content.kind).toBe('entity');
    expect(content.action).toBe('create');
    expect(content.entity).toBe('Book');
  });
});
