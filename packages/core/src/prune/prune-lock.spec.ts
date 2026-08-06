// packages/core/src/prune/prune-lock.spec.ts
import { describe, expect, it } from 'vitest';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { LeaseCapableStorage } from '../storage/storage-provider.js';
import { isLeaseCapableStorage } from '../storage/storage-provider.js';
import { PRUNE_LOCK_KEY, StorageLeasePruneLock } from './prune-lock.js';

function request(owner: string, ttlMs = 60_000): { key: string; owner: string; ttlMs: number } {
  return { key: PRUNE_LOCK_KEY, owner, ttlMs };
}

/**
 * A bare StorageProvider whose lease half the test supplies. Written out rather
 * than spread from an InMemoryStorageProvider: that class keeps its methods on
 * the prototype, so a spread would silently drop every one of them.
 */
function storageWithLeases(leases: Partial<LeaseCapableStorage>): LeaseCapableStorage {
  return {
    store: () => Promise.resolve(),
    update: () => Promise.resolve(),
    find: () => Promise.resolve(null),
    get: () => Promise.resolve({ data: [], nextCursor: null }),
    batch: () => Promise.resolve([]),
    tags: () => Promise.resolve([]),
    prune: () => Promise.resolve(0),
    clear: () => Promise.resolve(),
    tryAcquireLease: () => Promise.resolve(true),
    releaseLease: () => Promise.resolve(),
    ...leases,
  };
}

describe('StorageLeasePruneLock', () => {
  it('grants the lease to exactly one of two contenders', async () => {
    const lock = new StorageLeasePruneLock(new InMemoryStorageProvider());

    const first = await lock.acquire(request('pod-a'));
    const second = await lock.acquire(request('pod-b'));

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    // `held`, not `unavailable` — the difference decides whether the pruner
    // stands down or prunes anyway.
    if (!second.acquired) expect(second.reason).toBe('held');
  });

  it('lets the next contender in after the holder releases', async () => {
    const lock = new StorageLeasePruneLock(new InMemoryStorageProvider());

    const first = await lock.acquire(request('pod-a'));
    if (!first.acquired) throw new Error('expected the first acquire to win');
    expect((await lock.acquire(request('pod-b'))).acquired).toBe(false);

    await first.lease.release();
    expect((await lock.acquire(request('pod-b'))).acquired).toBe(true);
  });

  it('reclaims a lease whose holder died without releasing', async () => {
    const storage = new InMemoryStorageProvider();
    const lock = new StorageLeasePruneLock(storage);

    // A short-lived lease that is never released — the SIGKILLed-pod case.
    const dead = await lock.acquire(request('pod-a', 30));
    expect(dead.acquired).toBe(true);
    expect((await lock.acquire(request('pod-b', 30))).acquired).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 40));

    // Without the TTL this would block the entire fleet from ever pruning again.
    expect((await lock.acquire(request('pod-b', 30))).acquired).toBe(true);
  });

  it('ignores a release from a holder whose lease was already re-granted', async () => {
    const storage = new InMemoryStorageProvider();
    const lock = new StorageLeasePruneLock(storage);

    const stale = await lock.acquire(request('pod-a', 20));
    if (!stale.acquired) throw new Error('expected the first acquire to win');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const fresh = await lock.acquire(request('pod-b'));
    expect(fresh.acquired).toBe(true);

    // The slow original holder finally finishes and releases. It must NOT hand
    // pod-b's lease away, or two pods end up pruning at once anyway.
    await stale.lease.release();
    expect((await lock.acquire(request('pod-c'))).acquired).toBe(false);
  });

  it('re-grants to the same owner (a restart is not locked out by its own lease)', async () => {
    const lock = new StorageLeasePruneLock(new InMemoryStorageProvider());

    expect((await lock.acquire(request('pod-a'))).acquired).toBe(true);
    expect((await lock.acquire(request('pod-a'))).acquired).toBe(true);
  });

  it('reports a throwing store as unavailable, never as held', async () => {
    const broken = storageWithLeases({
      tryAcquireLease: () => Promise.reject(new Error('no such table: telescope_leases')),
    });
    const result = await new StorageLeasePruneLock(broken).acquire(request('pod-a'));

    expect(result.acquired).toBe(false);
    // `unavailable` is what makes the pruner fail OPEN. Reporting `held` here
    // would silently stop retention across the whole fleet.
    if (!result.acquired) {
      expect(result.reason).toBe('unavailable');
      expect(result.detail).toContain('telescope_leases');
    }
  });

  it('swallows a failing release rather than rejecting the caller', async () => {
    const flaky = storageWithLeases({
      releaseLease: () => Promise.reject(new Error('connection reset')),
    });
    const result = await new StorageLeasePruneLock(flaky).acquire(request('pod-a'));
    if (!result.acquired) throw new Error('expected the acquire to win');

    await expect(result.lease.release()).resolves.toBeUndefined();
  });
});

describe('isLeaseCapableStorage', () => {
  it('accepts a provider with both halves and rejects one with either missing', () => {
    expect(isLeaseCapableStorage(new InMemoryStorageProvider())).toBe(true);

    const { tryAcquireLease: _acquire, ...withoutAcquire } = storageWithLeases({});
    expect(isLeaseCapableStorage(withoutAcquire)).toBe(false);

    const { releaseLease: _release, ...withoutRelease } = storageWithLeases({});
    expect(isLeaseCapableStorage(withoutRelease)).toBe(false);
  });
});
