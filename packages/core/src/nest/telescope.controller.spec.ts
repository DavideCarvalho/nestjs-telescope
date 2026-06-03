// packages/core/src/nest/telescope.controller.spec.ts
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeController } from './telescope.controller.js';
import { TelescopeService } from './telescope.service.js';

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
    traceId: null,
    spanId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function setup() {
  const storage = new InMemoryStorageProvider();
  const service = new TelescopeService(resolveConfig({}), storage, {});
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

  it('lists entries filtered by traceId', async () => {
    const { storage, controller } = setup();
    await storage.store([
      entry({ id: 'a1', traceId: 'trace-A' }),
      entry({ id: 'b1', traceId: 'trace-B' }),
      entry({ id: 'none', traceId: null }),
    ]);
    const page = await controller.list({ traceId: 'trace-A' });
    expect(page.data.map((e) => e.id)).toEqual(['a1']);
  });

  it('falls back to provider default when limit is a non-numeric string', async () => {
    const { storage, controller } = setup();
    await storage.store([entry({ id: '1' }), entry({ id: '2' })]);
    const page = await controller.list({ limit: 'abc' });
    expect(page.data).toHaveLength(2);
  });

  it('returns an entry with its batch', async () => {
    const { storage, controller } = setup();
    await storage.store([
      entry({ id: '1', batchId: 'b', sequence: 0 }),
      entry({ id: '2', batchId: 'b', sequence: 1 }),
    ]);
    const found = await controller.show('1');
    expect(found?.batch.map((e) => e.id)).toEqual(['1', '2']);
  });

  it('exposes meta', async () => {
    const { controller } = setup();
    const meta = await controller.meta();
    expect(meta.enabled).toBe(true);
  });
});
