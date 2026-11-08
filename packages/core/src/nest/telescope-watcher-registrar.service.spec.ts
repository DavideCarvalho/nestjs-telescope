// packages/core/src/nest/telescope-watcher-registrar.service.spec.ts
import type { ModuleRef } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { ExtensionRegistry } from '../extension/registry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeWatcherRegistrar } from './telescope-watcher-registrar.service.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';
import type { Watcher } from './watcher.js';

describe('TelescopeWatcherRegistrar', () => {
  it('isolates a throwing watcher and still reports every configured type', async () => {
    const goodWatcher: Watcher = {
      type: 'good',
      register: vi.fn(() => Promise.resolve()),
    };
    const throwingWatcher: Watcher = {
      type: 'bad',
      register: vi.fn(() => Promise.reject(new Error('boom'))),
    };

    const config = resolveConfig({});
    const service = new TelescopeService(config, new InMemoryStorageProvider(), {});
    const setWatchers = vi.spyOn(service, 'setWatchers');

    const options: TelescopeModuleOptions = { watchers: [goodWatcher, throwingWatcher] };
    const extensions = new ExtensionRegistry([], { moduleRef: {} as ModuleRef, config });
    const registrar = new TelescopeWatcherRegistrar(
      options,
      config,
      service,
      extensions,
      {} as ModuleRef,
    );

    await expect(registrar.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(goodWatcher.register).toHaveBeenCalledOnce();
    expect(throwingWatcher.register).toHaveBeenCalledOnce();
    // 'bad' threw in register() → it must NOT be reported as an active watcher.
    expect(setWatchers).toHaveBeenCalledWith(['request', 'exception', 'good']);
  });

  it('unregisters every successfully registered watcher on shutdown, isolating a throw', async () => {
    const good: Watcher = { type: 'good', register: vi.fn(), unregister: vi.fn() };
    const failing: Watcher = {
      type: 'failing-unregister',
      register: vi.fn(),
      unregister: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    const neverRegistered: Watcher = {
      type: 'bad',
      register: vi.fn(() => Promise.reject(new Error('boom'))),
      unregister: vi.fn(),
    };
    const plain: Watcher = { type: 'plain', register: vi.fn() };
    const config = resolveConfig({});
    const service = new TelescopeService(config, new InMemoryStorageProvider(), {});
    const registrar = new TelescopeWatcherRegistrar(
      { watchers: [good, failing, neverRegistered, plain] },
      config,
      service,
      new ExtensionRegistry([], { moduleRef: {} as ModuleRef, config }),
      {} as ModuleRef,
    );
    await registrar.onApplicationBootstrap();
    await expect(registrar.onApplicationShutdown()).resolves.toBeUndefined();
    expect(good.unregister).toHaveBeenCalledOnce();
    expect(failing.unregister).toHaveBeenCalledOnce();
    expect(neverRegistered.unregister).not.toHaveBeenCalled();
    // A second shutdown does not unregister twice.
    await registrar.onApplicationShutdown();
    expect(good.unregister).toHaveBeenCalledOnce();
  });
});
