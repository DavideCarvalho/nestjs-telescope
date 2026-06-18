import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { TelescopeRequestMiddleware } from '../nest/telescope-request.middleware.js';
import { TelescopeService } from '../nest/telescope.service.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { InspectorSessionLike } from './cpu-profiler.js';
import { CpuProfiler } from './cpu-profiler.js';
import { ProfilerService } from './profiler.service.js';
import { resolveProfilingConfig } from './profiling-config.js';
import type { V8CpuProfile } from './types.js';

const SAMPLE_PROFILE: V8CpuProfile = {
  nodes: [
    {
      id: 1,
      callFrame: {
        functionName: '(root)',
        scriptId: '0',
        url: '',
        lineNumber: -1,
        columnNumber: -1,
      },
      children: [2],
    },
    {
      id: 2,
      callFrame: {
        functionName: 'handler',
        scriptId: '1',
        url: 'app.js',
        lineNumber: 9,
        columnNumber: 0,
      },
    },
  ],
  samples: [2, 2, 2],
  timeDeltas: [1000, 1000, 1000],
  startTime: 0,
  endTime: 3000,
};

function spySessionFactory(): { factory: () => InspectorSessionLike; created: { count: number } } {
  const created = { count: 0 };
  const factory = (): InspectorSessionLike => {
    created.count += 1;
    return {
      connect: () => {},
      disconnect: () => {},
      post: (method, paramsOrCb, cb) => {
        const callback = typeof paramsOrCb === 'function' ? paramsOrCb : cb;
        callback?.(null, method === 'Profiler.stop' ? { profile: SAMPLE_PROFILE } : {});
      },
    };
  };
  return { factory, created };
}

function request(url = '/orders/42') {
  return { method: 'GET', url, headers: {}, socket: { remoteAddress: '10.0.0.1' } };
}

describe('profiling — middleware integration', () => {
  it('captures and records a cpu_profile entry correlated to the request batch (sampled)', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(
      resolveConfig({ profiling: { enabled: true, sampleRate: 1 } }),
      storage,
      {},
    );
    const { factory, created } = spySessionFactory();
    const profiler = new ProfilerService(resolveProfilingConfig({ enabled: true, sampleRate: 1 }), {
      record: (input) => service.record(input),
      random: () => 0,
      profilerFactory: () => new CpuProfiler(factory),
    });
    const mw = new TelescopeRequestMiddleware(service, profiler);

    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    mw.use(request(), res, vi.fn());
    res.emit('finish');
    // The capture's stop() + record happen on a microtask; let them settle.
    await new Promise((r) => setImmediate(r));
    await service.flush();

    expect(created.count).toBe(1); // a session WAS created (profiling on)
    const all = (await storage.get({})).data;
    const profile = all.find((e) => e.type === 'cpu_profile');
    const req = all.find((e) => e.type === 'request');
    expect(profile).toBeDefined();
    expect(profile?.batchId).toBe(req?.batchId); // correlated to the request batch
    expect(profile?.familyHash).toBe('GET /orders/:id');
    const content = profile?.content as { tree: { name: string }; label: string };
    expect(content.tree.name).toBe('(root)');
    expect(content.label).toBe('GET /orders/:id');
  });

  it('ZERO inspector usage when profiling is disabled — session factory never invoked', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const { factory, created } = spySessionFactory();
    const profilerFactory = vi.fn(() => new CpuProfiler(factory));
    const profiler = new ProfilerService(resolveProfilingConfig({ enabled: false }), {
      record: (input) => service.record(input),
      // biome-ignore lint/suspicious/noExplicitAny: spy
      profilerFactory: profilerFactory as any,
    });
    const mw = new TelescopeRequestMiddleware(service, profiler);

    for (let i = 0; i < 5; i++) {
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      mw.use(request(`/orders/${i}`), res, vi.fn());
      res.emit('finish');
    }
    await new Promise((r) => setImmediate(r));
    await service.flush();

    // Neither the CpuProfiler factory nor the underlying inspector session was touched.
    expect(profilerFactory).not.toHaveBeenCalled();
    expect(created.count).toBe(0);
    // And no cpu_profile entries were recorded.
    const all = (await storage.get({})).data;
    expect(all.some((e) => e.type === 'cpu_profile')).toBe(false);
  });

  it('does not profile when enabled but not sampled (rate 0, nothing armed)', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(
      resolveConfig({ profiling: { enabled: true, sampleRate: 0 } }),
      storage,
      {},
    );
    const { factory, created } = spySessionFactory();
    const profiler = new ProfilerService(resolveProfilingConfig({ enabled: true, sampleRate: 0 }), {
      record: (input) => service.record(input),
      profilerFactory: () => new CpuProfiler(factory),
    });
    const mw = new TelescopeRequestMiddleware(service, profiler);

    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    mw.use(request(), res, vi.fn());
    res.emit('finish');
    await new Promise((r) => setImmediate(r));
    await service.flush();

    expect(created.count).toBe(0);
    const all = (await storage.get({})).data;
    expect(all.some((e) => e.type === 'cpu_profile')).toBe(false);
  });

  it('manual arm captures the next request even with sampleRate 0', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(
      resolveConfig({ profiling: { enabled: true, sampleRate: 0 } }),
      storage,
      {},
    );
    const { factory, created } = spySessionFactory();
    const profiler = new ProfilerService(resolveProfilingConfig({ enabled: true, sampleRate: 0 }), {
      record: (input) => service.record(input),
      profilerFactory: () => new CpuProfiler(factory),
    });
    profiler.arm({ count: 1 });
    const mw = new TelescopeRequestMiddleware(service, profiler);

    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    mw.use(request(), res, vi.fn());
    res.emit('finish');
    await new Promise((r) => setImmediate(r));
    await service.flush();

    expect(created.count).toBe(1);
    const all = (await storage.get({})).data;
    const profile = all.find((e) => e.type === 'cpu_profile');
    expect(profile).toBeDefined();
    expect((profile?.content as { reason: string }).reason).toBe('manual');
  });
});
