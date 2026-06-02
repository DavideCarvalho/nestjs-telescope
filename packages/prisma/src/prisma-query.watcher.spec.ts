// packages/prisma/src/prisma-query.watcher.spec.ts
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { type PrismaQueryEvent, PrismaQueryWatcher } from './prisma-query.watcher.js';

/** A structural fake of the Prisma `query` event channel. Captures the callback
 *  registered via `$on('query')` so tests can invoke it directly — no real
 *  PrismaClient or database. */
class FakePrismaClient {
  callback: ((event: PrismaQueryEvent) => void) | undefined;
  $on(_event: 'query', callback: (event: PrismaQueryEvent) => void): void {
    this.callback = callback;
  }
}

function makeHarness(): { ctx: WatcherContext; recorded: RecordInput[] } {
  const recorded: RecordInput[] = [];
  const ctx: WatcherContext = {
    record: (input) => recorded.push(input),
    runInBatch: async <T>(_origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => fn(),
    beginBatch: (): BatchHandle => ({ id: 'batch', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: { get: () => undefined } as unknown as WatcherContext['moduleRef'],
  };
  return { ctx, recorded };
}

describe('PrismaQueryWatcher', () => {
  it('records a query entry with sql, bindings, took, familyHash, and durationMs', () => {
    const { ctx, recorded } = makeHarness();
    const client = new FakePrismaClient();
    new PrismaQueryWatcher(client).register(ctx);

    client.callback?.({
      query: 'SELECT * FROM "User" WHERE id = $1',
      params: '[42]',
      duration: 5,
    });

    expect(recorded).toHaveLength(1);
    const entry = recorded[0]!;
    expect(entry.type).toBe('query');
    expect((entry.content as { sql: string }).sql).toContain('SELECT * FROM "User"');
    expect((entry.content as { bindings: unknown[] }).bindings).toEqual([42]);
    expect((entry.content as { took: number }).took).toBe(5);
    expect(entry.familyHash).toBeTruthy();
    expect(entry.durationMs).toBe(5);
  });

  it('tags slow queries when duration >= the default slowMs (1000)', () => {
    const { ctx, recorded } = makeHarness();
    const client = new FakePrismaClient();
    new PrismaQueryWatcher(client).register(ctx);

    client.callback?.({ query: 'SELECT 1', params: '[]', duration: 2000 });

    expect(recorded[0]!.tags).toContain('slow');
  });

  it('degrades malformed params to an empty bindings array without throwing', () => {
    const { ctx, recorded } = makeHarness();
    const client = new FakePrismaClient();
    new PrismaQueryWatcher(client).register(ctx);

    expect(() =>
      client.callback?.({ query: 'SELECT 1', params: 'not-json', duration: 1 }),
    ).not.toThrow();
    expect((recorded[0]!.content as { bindings: unknown[] }).bindings).toEqual([]);
  });

  it('produces entries of type "query"', () => {
    const { ctx, recorded } = makeHarness();
    const client = new FakePrismaClient();
    new PrismaQueryWatcher(client).register(ctx);

    client.callback?.({ query: 'SELECT 1', params: '[]', duration: 1 });

    expect(recorded[0]!.type).toBe('query');
  });
});
