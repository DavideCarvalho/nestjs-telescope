// packages/core/src/topology/known-apps.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { KNOWN_APPS_REFRESH_MS, TelescopeKnownApps } from './known-apps.js';

const entry = (id: string, tags: string[]): Entry => ({
  id,
  batchId: id,
  type: 'request',
  familyHash: null,
  content: {},
  tags,
  sequence: 0,
  durationMs: null,
  origin: 'http',
  instanceId: 'i',
  traceId: null,
  spanId: null,
  createdAt: new Date(),
});

describe('TelescopeKnownApps', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the store once, then answers from memory and the ingest', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([entry('a', ['app:shop']), entry('b', ['app:billing', 'user:1'])]);
    const tags = vi.spyOn(storage, 'tags');
    const apps = new TelescopeKnownApps(storage);

    expect(await apps.list()).toEqual(['billing', 'shop']);
    apps.note('crm');
    expect(await apps.list()).toEqual(['billing', 'crm', 'shop']);
    expect(await apps.list()).toEqual(['billing', 'crm', 'shop']);
    expect(tags).toHaveBeenCalledTimes(1);
    expect(tags).toHaveBeenCalledWith('app:', { limit: 5_000 });
  });

  it('refreshes from the store in the background once the last read is old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const storage = new InMemoryStorageProvider();
    const apps = new TelescopeKnownApps(storage);
    expect(await apps.list()).toEqual([]);

    // Another replica ingested an app: this one learns it on the next refresh.
    await storage.store([entry('a', ['app:shop'])]);
    expect(await apps.list()).toEqual([]);
    vi.setSystemTime(Date.now() + KNOWN_APPS_REFRESH_MS);
    await apps.list();
    await vi.waitFor(async () => expect(await apps.list()).toEqual(['shop']));
  });

  it('keeps answering when the store fails', async () => {
    const storage = new InMemoryStorageProvider();
    vi.spyOn(storage, 'tags').mockRejectedValue(new Error('down'));
    const apps = new TelescopeKnownApps(storage);
    apps.note('shop');
    expect(await apps.list()).toEqual(['shop']);
  });
});
