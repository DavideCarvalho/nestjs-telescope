import { describe, expect, it, vi } from 'vitest';
import type { CpuProfilerResult } from './cpu-profiler.js';
import { ProfilerService } from './profiler.service.js';
import { resolveProfilingConfig } from './profiling-config.js';

const RESULT: CpuProfilerResult = {
  tree: { name: '(root)', file: '', selfMs: 0, totalMs: 5, totalSamples: 5, children: [] },
  durationMs: 5,
  sampleCount: 5,
  hot: [],
};

/** A fake profiler that records start/stop and returns a canned result. */
function fakeProfiler() {
  const events: string[] = [];
  let running = false;
  return {
    events,
    factory: vi.fn(() => ({
      get isRunning() {
        return running;
      },
      start: vi.fn(async () => {
        events.push('start');
        running = true;
      }),
      stop: vi.fn(async () => {
        events.push('stop');
        running = false;
        return RESULT;
      }),
    })),
  };
}

function makeService(
  overrides: Partial<Parameters<typeof resolveProfilingConfig>[0]> = {},
  deps: {
    record?: (input: unknown) => void;
    random?: () => number;
    profilerFactory?: () => unknown;
  } = {},
) {
  const records: unknown[] = [];
  const fp = fakeProfiler();
  const config = resolveProfilingConfig({ enabled: true, ...overrides });
  const service = new ProfilerService(config, {
    record: deps.record ?? ((input) => records.push(input)),
    random: deps.random ?? (() => 0.99),
    // biome-ignore lint/suspicious/noExplicitAny: test factory
    profilerFactory: (deps.profilerFactory as any) ?? (fp.factory as any),
  });
  return { service, records, fp };
}

describe('ProfilerService — disabled', () => {
  it('never constructs a profiler when disabled (zero overhead guarantee)', async () => {
    const profilerFactory = vi.fn();
    const config = resolveProfilingConfig({ enabled: false });
    const service = new ProfilerService(config, {
      record: () => {},
      random: () => 0,
      // biome-ignore lint/suspicious/noExplicitAny: spy factory
      profilerFactory: profilerFactory as any,
    });
    // shouldProfile must be false and no profiler created even if we force-begin.
    expect(service.shouldProfile('GET /x')).toBe(false);
    const handle = service.begin('GET /x');
    expect(handle).toBeNull();
    await service.end(handle, 'GET /x');
    expect(profilerFactory).not.toHaveBeenCalled();
  });

  it('reports disabled status', () => {
    const config = resolveProfilingConfig({ enabled: false });
    const service = new ProfilerService(config, { record: () => {} });
    expect(service.status().enabled).toBe(false);
  });
});

describe('ProfilerService — sampling', () => {
  it('does not sample when sampleRate is 0 and nothing is armed', () => {
    const { service } = makeService({ sampleRate: 0 });
    expect(service.shouldProfile('GET /x')).toBe(false);
  });

  it('samples when random falls under sampleRate', () => {
    const { service } = makeService({ sampleRate: 0.5 }, { random: () => 0.1 });
    expect(service.shouldProfile('GET /x')).toBe(true);
  });

  it('does not sample when random exceeds sampleRate', () => {
    const { service } = makeService({ sampleRate: 0.5 }, { random: () => 0.9 });
    expect(service.shouldProfile('GET /x')).toBe(false);
  });
});

describe('ProfilerService — manual trigger', () => {
  it('arms the next N requests regardless of sampleRate', () => {
    const { service } = makeService({ sampleRate: 0 }, { random: () => 0.99 });
    service.arm({ count: 2 });
    expect(service.shouldProfile('GET /a')).toBe(true);
    expect(service.shouldProfile('GET /b')).toBe(true);
  });

  it('arms only matching label when a label filter is given', () => {
    const { service } = makeService({ sampleRate: 0 });
    service.arm({ count: 5, label: 'GET /users/:id' });
    expect(service.shouldProfile('GET /other')).toBe(false);
    expect(service.shouldProfile('GET /users/:id')).toBe(true);
  });

  it('decrements the manual budget as captures complete', async () => {
    const { service, fp } = makeService({ sampleRate: 0 });
    service.arm({ count: 1 });
    const handle = service.begin('GET /a');
    expect(handle).not.toBeNull();
    await service.end(handle, 'GET /a');
    expect(service.status().pendingManual).toBe(0);
    expect(fp.events).toContain('start');
    expect(fp.events).toContain('stop');
  });
});

describe('ProfilerService — capture lifecycle', () => {
  it('records a cpu_profile entry on a completed capture', async () => {
    const { service, records } = makeService({ sampleRate: 1 }, { random: () => 0 });
    const handle = service.begin('GET /a');
    await service.end(handle, 'GET /a');
    expect(records).toHaveLength(1);
    const entry = records[0] as { type: string; content: { label: string; tree: unknown } };
    expect(entry.type).toBe('cpu_profile');
    expect(entry.content.label).toBe('GET /a');
    expect(entry.content.tree).toBeDefined();
  });

  it('caps concurrent captures', () => {
    const { service } = makeService({ sampleRate: 1, maxConcurrent: 1 }, { random: () => 0 });
    const a = service.begin('GET /a');
    const b = service.begin('GET /b');
    expect(a).not.toBeNull();
    expect(b).toBeNull(); // over the cap
  });

  it('discards a capture shorter than minDurationMs without recording', async () => {
    const records: unknown[] = [];
    const config = resolveProfilingConfig({ enabled: true, sampleRate: 1, minDurationMs: 100 });
    const fp = fakeProfiler();
    const service = new ProfilerService(config, {
      record: (i) => records.push(i),
      random: () => 0,
      // biome-ignore lint/suspicious/noExplicitAny: test factory
      profilerFactory: fp.factory as any,
    });
    const handle = service.begin('GET /a');
    await service.end(handle, 'GET /a'); // RESULT.durationMs = 5 < 100
    expect(records).toHaveLength(0);
  });

  it('end(null) is a safe no-op', async () => {
    const { service, records } = makeService({ sampleRate: 0 });
    await service.end(null, 'GET /a');
    expect(records).toHaveLength(0);
  });
});
