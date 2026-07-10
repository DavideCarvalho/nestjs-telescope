// packages/core/src/schedule/schedule-manager.registry.spec.ts
import type { ModuleRef } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import type { TelescopeModuleOptions } from '../nest/telescope.options.js';
import type { WatcherContext } from '../nest/watcher.js';
import type { Watcher } from '../nest/watcher.js';
import type { ScheduleManager, ScheduledTask } from './schedule-manager.js';
import { ScheduleManagerRegistry } from './schedule-manager.registry.js';

// ModuleRef is never invoked by the registry (it only forwards it on ctx); an
// empty stub matches the existing manager-registry spec scaffolding.
const moduleRef = {} as ModuleRef;

function fakeWatcher(type: string): Watcher {
  return {
    type,
    register: vi.fn((_ctx: WatcherContext) => {}),
  };
}

function fakeScheduleManagerWatcher(type: string, onInit?: () => void): Watcher & ScheduleManager {
  return {
    ...fakeWatcher(type),
    init: vi.fn(() => {
      onInit?.();
    }),
    listTasks: (): Promise<ScheduledTask[]> => Promise.resolve([]),
  };
}

function fakeStandaloneManager(onInit?: () => void): ScheduleManager {
  return {
    init: vi.fn(() => {
      onInit?.();
    }),
    listTasks: (): Promise<ScheduledTask[]> => Promise.resolve([]),
  };
}

describe('ScheduleManagerRegistry', () => {
  it('auto-registers a watcher implementing the ScheduleManager SPI without listing it in scheduleManagers', async () => {
    const watcherManager = fakeScheduleManagerWatcher('schedule');
    const config = resolveConfig({ enabled: true });
    const options: TelescopeModuleOptions = { watchers: [watcherManager] };

    const registry = new ScheduleManagerRegistry(options, config, moduleRef);
    await registry.onApplicationBootstrap();

    expect(watcherManager.init).toHaveBeenCalledOnce();
    expect(registry.all()).toEqual([watcherManager]);
  });

  it('inits a watcher listed in BOTH watchers and scheduleManagers exactly once', async () => {
    const watcherManager = fakeScheduleManagerWatcher('schedule');
    const config = resolveConfig({ enabled: true });
    const options: TelescopeModuleOptions = {
      watchers: [watcherManager],
      scheduleManagers: [watcherManager],
    };

    const registry = new ScheduleManagerRegistry(options, config, moduleRef);
    await registry.onApplicationBootstrap();

    expect(watcherManager.init).toHaveBeenCalledOnce();
    expect(registry.all()).toEqual([watcherManager]);
  });

  it('does not collect a plain watcher that does not implement the SPI', async () => {
    const plainWatcher = fakeWatcher('http');
    const config = resolveConfig({ enabled: true });
    const options: TelescopeModuleOptions = { watchers: [plainWatcher] };

    const registry = new ScheduleManagerRegistry(options, config, moduleRef);
    await registry.onApplicationBootstrap();

    expect(registry.all()).toEqual([]);
  });

  it('still inits a standalone manager that is not a watcher', async () => {
    const standalone = fakeStandaloneManager();
    const config = resolveConfig({ enabled: true });
    const options: TelescopeModuleOptions = { scheduleManagers: [standalone] };

    const registry = new ScheduleManagerRegistry(options, config, moduleRef);
    await registry.onApplicationBootstrap();

    expect(standalone.init).toHaveBeenCalledOnce();
    expect(registry.all()).toEqual([standalone]);
  });

  it('combines standalone managers with SPI-implementing watchers', async () => {
    const standalone = fakeStandaloneManager();
    const watcherManager = fakeScheduleManagerWatcher('schedule');
    const config = resolveConfig({ enabled: true });
    const options: TelescopeModuleOptions = {
      scheduleManagers: [standalone],
      watchers: [watcherManager],
    };

    const registry = new ScheduleManagerRegistry(options, config, moduleRef);
    await registry.onApplicationBootstrap();

    expect(registry.all()).toEqual([standalone, watcherManager]);
  });

  it('inits nothing when telescope is disabled', async () => {
    const watcherManager = fakeScheduleManagerWatcher('schedule');
    const config = resolveConfig({ enabled: false });
    const options: TelescopeModuleOptions = { watchers: [watcherManager] };

    const registry = new ScheduleManagerRegistry(options, config, moduleRef);
    await registry.onApplicationBootstrap();

    expect(watcherManager.init).not.toHaveBeenCalled();
    expect(registry.all()).toEqual([]);
  });
});
