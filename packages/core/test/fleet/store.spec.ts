import { describe, expect, it } from 'vitest';
import { type InstanceRecord, MemoryFleetStore } from '../../src/index.js';

const record = (app: string, instanceId: string, lastSeenAt = 1): InstanceRecord => ({
  app,
  instanceId,
  host: instanceId,
  pid: 1,
  version: null,
  bootedAt: 0,
  firstSeenAt: 0,
  lastSeenAt,
  state: 'ready',
  intervalMs: 15_000,
  checks: [],
  shipping: null,
});

describe('MemoryFleetStore', () => {
  it('a tenant rotating instance ids only evicts its own rows', async () => {
    const store = new MemoryFleetStore(100, 3);
    await store.upsert(record('billing', 'b-1'));
    for (let i = 0; i < 50; i++) await store.upsert(record('shop', `s-${i}`));
    const rows = await store.list();
    expect(rows.filter((r) => r.app === 'billing').map((r) => r.instanceId)).toEqual(['b-1']);
    expect(rows.filter((r) => r.app === 'shop').map((r) => r.instanceId)).toEqual([
      's-47',
      's-48',
      's-49',
    ]);
  });

  it('past the total, evicts from the largest app first', async () => {
    const store = new MemoryFleetStore(4, 10);
    await store.upsert(record('billing', 'b-1'));
    for (let i = 0; i < 5; i++) await store.upsert(record('shop', `s-${i}`));
    const rows = await store.list();
    expect(rows).toHaveLength(4);
    expect(rows.some((r) => r.app === 'billing')).toBe(true);
  });

  it('lists by app and since, and prunes', async () => {
    const store = new MemoryFleetStore();
    await store.upsert(record('a', '1', 10));
    await store.upsert(record('b', '2', 20));
    expect((await store.list({ apps: ['a'] })).map((r) => r.app)).toEqual(['a']);
    expect((await store.list({ since: 15 })).map((r) => r.app)).toEqual(['b']);
    expect(await store.prune(15)).toBe(1);
    expect((await store.list()).map((r) => r.app)).toEqual(['b']);
  });
});
