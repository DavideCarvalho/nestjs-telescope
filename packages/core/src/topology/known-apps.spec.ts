// packages/core/src/topology/known-apps.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import {
  KNOWN_APPS_RECENT_ENTRIES,
  KNOWN_APPS_REFRESH_MS,
  type KnownAppsSource,
  TelescopeKnownApps,
} from './known-apps.js';

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

  it('without a registry, reads the newest entries of the store once, then answers from memory', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([entry('a', ['app:shop']), entry('b', ['app:billing', 'user:1'])]);
    const tags = vi.spyOn(storage, 'tags');
    const apps = new TelescopeKnownApps(storage);

    expect(await apps.list()).toEqual(['billing', 'shop']);
    apps.note('crm');
    expect(await apps.list()).toEqual(['billing', 'crm', 'shop']);
    expect(await apps.list()).toEqual(['billing', 'crm', 'shop']);
    expect(tags).toHaveBeenCalledTimes(1);
    expect(tags).toHaveBeenCalledWith('app:', {
      limit: 5_000,
      recent: KNOWN_APPS_RECENT_ENTRIES,
    });
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

  it("reads the instance registry instead of the store's tags", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const storage = new InMemoryStorageProvider();
    // A low-traffic app whose entries a bounded tag count would miss.
    await storage.store([entry('a', ['app:old'])]);
    const tags = vi.spyOn(storage, 'tags');
    const registered = ['shop'];
    const fleet: KnownAppsSource = { instanceApps: vi.fn(async () => [...registered]) };
    const apps = new TelescopeKnownApps(storage, fleet);

    expect(await apps.list()).toEqual(['shop']);
    registered.push('billing');
    vi.setSystemTime(Date.now() + KNOWN_APPS_REFRESH_MS);
    await apps.list();
    await vi.waitFor(async () => expect(await apps.list()).toEqual(['billing', 'shop']));
    expect(tags).not.toHaveBeenCalled();
  });

  it('falls back to the bounded tag count while the registry is empty or fails', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([entry('a', ['app:shop'])]);
    const empty = new TelescopeKnownApps(storage, { instanceApps: async () => [] });
    expect(await empty.list()).toEqual(['shop']);
    const none = new TelescopeKnownApps(storage, { instanceApps: async () => null });
    expect(await none.list()).toEqual(['shop']);
    const failing = new TelescopeKnownApps(storage, {
      instanceApps: async () => {
        throw new Error('down');
      },
    });
    expect(await failing.list()).toEqual(['shop']);
  });
});
