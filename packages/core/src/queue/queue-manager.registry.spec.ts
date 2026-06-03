// packages/core/src/queue/queue-manager.registry.spec.ts
import type { ModuleRef } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import type { TelescopeModuleOptions } from '../nest/telescope.options.js';
import type {
  JobPage,
  QueueCounts,
  QueueJobDetail,
  QueueManager,
  QueueManagerContext,
  QueueState,
  QueueSummary,
} from './queue-manager.js';
import { QueueManagerRegistry } from './queue-manager.registry.js';

const EMPTY_COUNTS: QueueCounts = {
  waiting: 0,
  active: 0,
  delayed: 0,
  failed: 0,
  completed: 0,
  paused: 0,
};

function fakeManager(driver: string, onInit?: (ctx: QueueManagerContext) => void): QueueManager {
  return {
    driver,
    init: vi.fn((ctx: QueueManagerContext) => {
      onInit?.(ctx);
    }),
    listQueues: (): Promise<QueueSummary[]> => Promise.resolve([]),
    counts: (): Promise<QueueCounts> => Promise.resolve(EMPTY_COUNTS),
    listJobs: (): Promise<JobPage> => Promise.resolve({ jobs: [], nextCursor: null, total: null }),
    getJob: (): Promise<QueueJobDetail | null> => Promise.resolve(null),
  };
}

// ModuleRef is never invoked by the registry (it only forwards it on ctx); an
// empty stub matches the existing watcher-context spec scaffolding.
const moduleRef = {} as ModuleRef;

describe('QueueManagerRegistry', () => {
  it('inits each manager and exposes it via drivers()/get()', async () => {
    let capturedCtx: QueueManagerContext | undefined;
    const manager = fakeManager('fake', (ctx) => {
      capturedCtx = ctx;
    });
    const config = resolveConfig({ enabled: true });
    const options: TelescopeModuleOptions = { queueManagers: [manager] };

    const registry = new QueueManagerRegistry(options, config, moduleRef);
    await registry.onApplicationBootstrap();

    expect(manager.init).toHaveBeenCalledOnce();
    expect(registry.drivers()).toEqual(['fake']);
    expect(registry.get('fake')).toBe(manager);
    expect(registry.all()).toEqual([manager]);

    // ctx.redact is wired to core redaction and masks known sensitive keys.
    expect(capturedCtx?.redact({ password: 'hunter2', keep: 'ok' })).toEqual({
      password: '[REDACTED]',
      keep: 'ok',
    });
  });

  it('isolates a manager whose init throws (not registered, no throw)', async () => {
    const good = fakeManager('good');
    const bad: QueueManager = {
      ...fakeManager('bad'),
      init: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    const config = resolveConfig({ enabled: true });
    const options: TelescopeModuleOptions = { queueManagers: [good, bad] };

    const registry = new QueueManagerRegistry(options, config, moduleRef);

    await expect(registry.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(good.init).toHaveBeenCalledOnce();
    expect(bad.init).toHaveBeenCalledOnce();
    expect(registry.drivers()).toEqual(['good']);
    expect(registry.get('bad')).toBeUndefined();
  });

  it('inits nothing when telescope is disabled', async () => {
    const manager = fakeManager('fake');
    const config = resolveConfig({ enabled: false });
    const options: TelescopeModuleOptions = { queueManagers: [manager] };

    const registry = new QueueManagerRegistry(options, config, moduleRef);
    await registry.onApplicationBootstrap();

    expect(manager.init).not.toHaveBeenCalled();
    expect(registry.drivers()).toEqual([]);
  });
});
