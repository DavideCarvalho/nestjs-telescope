// packages/mikro-orm-watcher/src/mikro-orm-model.watcher.integration.spec.ts
//
// Integration: real MikroORM sqlite ORM (:memory:) + the MikroOrmModelWatcher.
// Validates that entity lifecycle changes (create/update/delete) are recorded
// as `model` entries with the right action/entity/id, and that the watcher
// degrades to a no-op when MikroORM is absent.
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
import { MikroOrmModelWatcher } from './mikro-orm-model.watcher.js';

interface AuthorShape {
  id: number;
  name: string;
}

const Author = new EntitySchema<AuthorShape>({
  name: 'Author',
  tableName: 'author',
  properties: {
    id: { type: 'integer', primary: true },
    name: { type: 'string' },
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

describe('MikroOrmModelWatcher integration (real sqlite ORM)', () => {
  let orm: MikroORM;
  let recorded: RecordInput[];

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Author],
      allowGlobalContext: true,
    });
    await orm.schema.create();

    const ctx = makeCtx(orm);
    recorded = ctx.recorded;
    new MikroOrmModelWatcher().register(ctx.ctx);
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it('has type "model"', () => {
    expect(new MikroOrmModelWatcher().type).toBe('model');
  });

  it('records a create entry with action/entity/id', async () => {
    recorded.length = 0;
    const em = orm.em.fork();
    em.create<AuthorShape>(Author, { id: 1, name: 'Ada Lovelace' });
    await em.flush();

    const creates = recorded.filter(
      (entry) => (entry.content as { action: string }).action === 'create',
    );
    expect(creates.length).toBeGreaterThan(0);
    const content = creates[0]!.content as {
      action: string;
      entity: string;
      id: string | null;
    };
    expect(content.action).toBe('create');
    expect(content.entity).toBe('Author');
    expect(content.id).toBe('1');
    expect(creates[0]!.type).toBe('model');
    expect(creates[0]!.tags).toContain('entity:Author');
  });

  it('records an update entry with the change set', async () => {
    recorded.length = 0;
    const em = orm.em.fork();
    const author = await em.findOneOrFail<AuthorShape>(Author, { id: 1 } as never);
    author.name = 'Ada King';
    await em.flush();

    const updates = recorded.filter(
      (entry) => (entry.content as { action: string }).action === 'update',
    );
    expect(updates.length).toBeGreaterThan(0);
    const content = updates[0]!.content as {
      action: string;
      entity: string;
      id: string | null;
      changes: Record<string, unknown> | null;
    };
    expect(content.action).toBe('update');
    expect(content.entity).toBe('Author');
    expect(content.id).toBe('1');
    expect(content.changes).toMatchObject({ name: 'Ada King' });
  });

  it('records a delete entry', async () => {
    recorded.length = 0;
    const em = orm.em.fork();
    const author = await em.findOneOrFail<AuthorShape>(Author, { id: 1 } as never);
    em.remove(author);
    await em.flush();

    const deletes = recorded.filter(
      (entry) => (entry.content as { action: string }).action === 'delete',
    );
    expect(deletes.length).toBeGreaterThan(0);
    const content = deletes[0]!.content as { action: string; entity: string };
    expect(content.action).toBe('delete');
    expect(content.entity).toBe('Author');
  });

  it('degrades to a no-op when MikroORM is absent', () => {
    const { ctx, recorded: rec } = makeCtx(undefined);
    expect(() => new MikroOrmModelWatcher().register(ctx)).not.toThrow();
    expect(rec).toHaveLength(0);
  });

  it('degrades to a no-op when the resolved provider has no event manager', () => {
    const { ctx, recorded: rec } = makeCtx({ notAnOrm: true });
    expect(() => new MikroOrmModelWatcher().register(ctx)).not.toThrow();
    expect(rec).toHaveLength(0);
  });
});
