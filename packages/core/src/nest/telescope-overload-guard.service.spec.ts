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
    const options: TelescopeModuleOptions = {
      overloadProtection: { maxEventLoopLagMs: 200, startupGraceMs: 0 },
    };
    const svc = service(options);
    const guard = new TelescopeOverloadGuard(options, svc);

    expect(svc.isPaused).toBe(false);
    sample(guard, 250); // over threshold
    expect(svc.isPaused).toBe(true);
    sample(guard, 10); // recovered
    expect(svc.isPaused).toBe(false);
  });

  it('startup grace discards the leading windows so a bootstrap stall never pauses', () => {
    // Default grace (~5s) over a 1s sample interval ⇒ 5 windows discarded.
    const options: TelescopeModuleOptions = { overloadProtection: { maxEventLoopLagMs: 200 } };
    const svc = service(options);
    const guard = new TelescopeOverloadGuard(options, svc);

    // Five huge "bootstrap" windows are all swallowed by the grace.
    for (let i = 0; i < 5; i++) {
      sample(guard, 1131);
      expect(svc.isPaused).toBe(false);
    }
    // Sixth window is now judged: a real sustained overload pauses.
    sample(guard, 1131);
    expect(svc.isPaused).toBe(true);
  });

  it('startupGraceMs: 0 arms immediately', () => {
    const options: TelescopeModuleOptions = {
      overloadProtection: { maxEventLoopLagMs: 200, startupGraceMs: 0 },
    };
    const svc = service(options);
    const guard = new TelescopeOverloadGuard(options, svc);

    sample(guard, 250);
    expect(svc.isPaused).toBe(true);
  });

  it('sub-interval startupGraceMs still discards at least the first window', () => {
    const options: TelescopeModuleOptions = {
      overloadProtection: { maxEventLoopLagMs: 200, startupGraceMs: 100 },
    };
    const svc = service(options);
    const guard = new TelescopeOverloadGuard(options, svc);

    sample(guard, 250); // first window swallowed by grace
    expect(svc.isPaused).toBe(false);
    sample(guard, 250); // armed
    expect(svc.isPaused).toBe(true);
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
