// packages/core/src/nest/watcher.spec.ts
import { describe, expect, it } from 'vitest';
import type { BatchHandle, Watcher, WatcherContext } from './watcher.js';

describe('Watcher SPI', () => {
  it('lets a minimal watcher be defined against the interface', () => {
    const calls: string[] = [];
    const watcher: Watcher = {
      type: 'demo',
      register(ctx: WatcherContext) {
        calls.push(`registered:${ctx.config.instanceId}`);
      },
    };
    const handle: BatchHandle = { id: 'b1', end: () => calls.push('ended') };
    const ctx = {
      record: () => calls.push('recorded'),
      beginBatch: () => handle,
      runInBatch: <T>(_o: BatchOriginLike, fn: () => Promise<T>) => fn(),
      config: { instanceId: 'pod-1' },
    } as unknown as WatcherContext;

    watcher.register(ctx);
    ctx.record({ type: 'demo', content: {} });
    handle.end();

    expect(watcher.type).toBe('demo');
    expect(calls).toEqual(['registered:pod-1', 'recorded', 'ended']);
  });
});

type BatchOriginLike = 'http' | 'queue' | 'schedule' | 'cli' | 'manual';
