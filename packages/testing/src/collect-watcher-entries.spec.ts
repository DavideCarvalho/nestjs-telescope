import type { Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { collectWatcherEntries } from './collect-watcher-entries.js';

describe('collectWatcherEntries', () => {
  it('captures a record call made during register', async () => {
    const watcher: Watcher = {
      type: 'demo',
      register(ctx: WatcherContext): void {
        ctx.record({ type: 'demo', content: {} });
      },
    };

    const { recorded } = await collectWatcherEntries(watcher);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ type: 'demo', content: {} });
  });

  it('beginBatch returns a handle with an id string', async () => {
    let handle: ReturnType<WatcherContext['beginBatch']> | undefined;

    const watcher: Watcher = {
      type: 'demo',
      register(ctx: WatcherContext): void {
        handle = ctx.beginBatch('manual');
      },
    };

    await collectWatcherEntries(watcher);

    expect(handle).toBeDefined();
    expect(typeof handle!.id).toBe('string');
    expect(handle!.id).toMatch(/^batch-/);
  });

  it('returns the context alongside recorded inputs', async () => {
    const watcher: Watcher = {
      type: 'demo',
      register(_ctx: WatcherContext): void {},
    };

    const { context, recorded } = await collectWatcherEntries(watcher);

    expect(context).toBeDefined();
    expect(Array.isArray(recorded)).toBe(true);
  });

  it('captures multiple record calls', async () => {
    const watcher: Watcher = {
      type: 'demo',
      register(ctx: WatcherContext): void {
        ctx.record({ type: 'demo', content: { n: 1 } });
        ctx.record({ type: 'demo', content: { n: 2 } });
      },
    };

    const { recorded } = await collectWatcherEntries(watcher);

    expect(recorded).toHaveLength(2);
  });
});
