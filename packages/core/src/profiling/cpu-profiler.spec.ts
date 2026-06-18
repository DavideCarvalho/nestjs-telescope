import { describe, expect, it, vi } from 'vitest';
import { CpuProfiler } from './cpu-profiler.js';
import type { InspectorSessionLike } from './cpu-profiler.js';
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
        functionName: 'work',
        scriptId: '1',
        url: 'a.js',
        lineNumber: 0,
        columnNumber: 0,
      },
    },
  ],
  samples: [2, 2],
  timeDeltas: [1000, 1000],
  startTime: 0,
  endTime: 2000,
};

/** A fake inspector session that records the protocol calls it receives. */
function fakeSession(): { session: InspectorSessionLike; calls: string[] } {
  const calls: string[] = [];
  const session: InspectorSessionLike = {
    connect: () => calls.push('connect'),
    disconnect: () => calls.push('disconnect'),
    post: (method, paramsOrCb, cb) => {
      calls.push(method);
      const callback = typeof paramsOrCb === 'function' ? paramsOrCb : cb;
      if (method === 'Profiler.stop') {
        callback?.(null, { profile: SAMPLE_PROFILE });
      } else {
        callback?.(null, {});
      }
    },
  };
  return { session, calls };
}

describe('CpuProfiler', () => {
  it('does NOT create a session until start() is called (zero overhead when idle)', () => {
    const factory = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: factory signature narrowed by ctor
    const profiler = new CpuProfiler(factory as any);
    expect(factory).not.toHaveBeenCalled();
    expect(profiler.isRunning).toBe(false);
  });

  it('connects + enables + starts the V8 profiler on start()', async () => {
    const { session, calls } = fakeSession();
    const profiler = new CpuProfiler(() => session);
    await profiler.start();
    expect(profiler.isRunning).toBe(true);
    expect(calls).toEqual([
      'connect',
      'Profiler.enable',
      'Profiler.setSamplingInterval',
      'Profiler.start',
    ]);
  });

  it('stops + aggregates + disconnects on stop()', async () => {
    const { session, calls } = fakeSession();
    const profiler = new CpuProfiler(() => session);
    await profiler.start();
    const result = await profiler.stop();
    expect(result).not.toBeNull();
    expect(result?.tree.name).toBe('(root)');
    expect(result?.sampleCount).toBe(2);
    expect(calls).toContain('Profiler.stop');
    expect(calls).toContain('disconnect');
    expect(profiler.isRunning).toBe(false);
  });

  it('start() while already running is a no-op (second profile not started)', async () => {
    const { session, calls } = fakeSession();
    const profiler = new CpuProfiler(() => session);
    await profiler.start();
    await profiler.start();
    expect(calls.filter((c) => c === 'Profiler.start')).toHaveLength(1);
  });

  it('stop() without start() returns null and never touches a session', async () => {
    const factory = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: factory signature narrowed by ctor
    const profiler = new CpuProfiler(factory as any);
    expect(await profiler.stop()).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it('respects a custom sampling interval', async () => {
    const posted: Array<[string, unknown]> = [];
    const session: InspectorSessionLike = {
      connect: () => {},
      disconnect: () => {},
      post: (method, paramsOrCb, cb) => {
        const params = typeof paramsOrCb === 'function' ? undefined : paramsOrCb;
        posted.push([method, params]);
        const callback = typeof paramsOrCb === 'function' ? paramsOrCb : cb;
        callback?.(null, method === 'Profiler.stop' ? { profile: SAMPLE_PROFILE } : {});
      },
    };
    const profiler = new CpuProfiler(() => session, { samplingIntervalMicros: 500 });
    await profiler.start();
    const interval = posted.find(([m]) => m === 'Profiler.setSamplingInterval');
    expect(interval?.[1]).toEqual({ interval: 500 });
  });
});
