import type {
  BatchHandle,
  BatchOrigin,
  RecordInput,
  WatcherContext,
} from '@dudousxd/nestjs-telescope';
import { describe, expect, it, vi } from 'vitest';

const familyHashCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@dudousxd/nestjs-telescope', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dudousxd/nestjs-telescope')>();
  return {
    ...original,
    queryFamilyHash: (sql: string) => {
      familyHashCalls.count += 1;
      return original.queryFamilyHash(sql);
    },
  };
});

const { queryFamilyHash, resolveConfig } = await import('@dudousxd/nestjs-telescope');
const { PrismaQueryWatcher } = await import('./prisma-query.watcher.js');

describe('PrismaQueryWatcher family hash', () => {
  it('is computed only when the recorder reads it, and only once', () => {
    const recorded: RecordInput[] = [];
    let emit: ((event: never) => void) | undefined;
    const ctx: WatcherContext = {
      record: (input) => recorded.push(input),
      runInBatch: async <T>(_origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => fn(),
      beginBatch: (): BatchHandle => ({ id: 'batch', end: () => {} }),
      config: resolveConfig({}),
      moduleRef: { get: () => undefined } as unknown as WatcherContext['moduleRef'],
    };
    new PrismaQueryWatcher({
      $on: (_event: 'query', callback: (event: never) => void) => {
        emit = callback;
      },
    } as never).register(ctx);
    familyHashCalls.count = 0;

    emit?.({ query: 'SELECT 1 FROM "User" WHERE id = $1', params: '[1]', duration: 3 } as never);
    expect(familyHashCalls.count).toBe(0);

    const expected = queryFamilyHash('SELECT 1 FROM "User" WHERE id = $1');
    familyHashCalls.count = 0;
    expect(recorded[0]?.familyHash).toBe(expected);
    expect(recorded[0]?.familyHash).toBe(expected);
    expect(familyHashCalls.count).toBe(1);
  });
});
