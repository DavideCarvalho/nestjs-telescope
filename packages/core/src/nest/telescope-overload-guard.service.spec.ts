// packages/core/src/nest/telescope-overload-guard.service.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeOverloadGuard } from './telescope-overload-guard.service.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

function service(options: TelescopeModuleOptions = {}) {
  return new TelescopeService(resolveConfig(options), new InMemoryStorageProvider(), options);
}

/** Reach the private sampler to drive a deterministic lag value. */
function sample(guard: TelescopeOverloadGuard, p99Ms: number): void {
  const ns = p99Ms * 1e6;
  (guard as unknown as { monitor: unknown }).monitor = {
    percentile: () => ns,
    reset: () => {},
    enable: () => {},
    disable: () => {},
  };
  (guard as unknown as { sample(): void }).sample();
}

describe('TelescopeOverloadGuard', () => {
  it('pauses capture when p99 lag crosses the threshold and resumes on recovery', () => {
    const svc = service({ overloadProtection: { maxEventLoopLagMs: 200 } });
    const guard = new TelescopeOverloadGuard(
      { overloadProtection: { maxEventLoopLagMs: 200 } },
      svc,
    );

    expect(svc.isPaused).toBe(false);
    sample(guard, 250); // over threshold
    expect(svc.isPaused).toBe(true);
    sample(guard, 10); // recovered
    expect(svc.isPaused).toBe(false);
  });

  it('paused recorder drops new records but keeps flushing', async () => {
    const svc = service();
    svc.pause();
    svc.record({ type: 'query', content: {} });
    await svc.flush();
    expect(svc.isPaused).toBe(true);
    svc.resume();
    svc.record({ type: 'query', content: {} });
    await svc.flush();
    expect(svc.isPaused).toBe(false);
  });

  it('is a no-op when overloadProtection is false', () => {
    const svc = service({ overloadProtection: false });
    const guard = new TelescopeOverloadGuard({ overloadProtection: false }, svc);
    guard.onModuleInit();
    expect((guard as unknown as { monitor: unknown }).monitor).toBeNull();
  });

  it('shuts down cleanly', () => {
    const svc = service();
    const guard = new TelescopeOverloadGuard({}, svc);
    expect(() => guard.onApplicationShutdown()).not.toThrow();
  });

  it('does not crash on a misbehaving monitor', () => {
    const svc = service();
    const guard = new TelescopeOverloadGuard({}, svc);
    (guard as unknown as { monitor: unknown }).monitor = {
      percentile: () => {
        throw new Error('boom');
      },
      reset: vi.fn(),
      enable: () => {},
      disable: () => {},
    };
    expect(() => (guard as unknown as { sample(): void }).sample()).not.toThrow();
  });
});
