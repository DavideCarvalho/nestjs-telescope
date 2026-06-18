// packages/core/src/metrics/server-stats.service.spec.ts
import { describe, expect, it } from 'vitest';
import type { ResolvedCoreConfig } from '../config/options.js';
import { resolveConfig } from '../config/resolve-config.js';

import { ServerStatsService } from './server-stats.service.js';

function config(): ResolvedCoreConfig {
  return resolveConfig({ instanceId: 'instance-7' });
}

describe('ServerStatsService', () => {
  it('returns a snapshot of finite process health numbers', () => {
    const service = new ServerStatsService(config());
    const stats = service.getStats();

    expect(stats.instanceId).toBe('instance-7');
    expect(Number.isFinite(stats.uptimeSec)).toBe(true);
    expect(stats.uptimeSec).toBeGreaterThanOrEqual(0);

    expect(Number.isFinite(stats.memory.rssMb)).toBe(true);
    expect(stats.memory.rssMb).toBeGreaterThan(0);
    expect(Number.isFinite(stats.memory.heapUsedMb)).toBe(true);
    expect(Number.isFinite(stats.memory.heapTotalMb)).toBe(true);

    expect(Number.isFinite(stats.cpu.userMs)).toBe(true);
    expect(stats.cpu.userMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(stats.cpu.systemMs)).toBe(true);

    // event-loop delay is either null (perf_hooks unavailable) or a finite number.
    expect(stats.eventLoopDelayMs === null || Number.isFinite(stats.eventLoopDelayMs)).toBe(true);

    service.onApplicationShutdown();
  });

  it('reports a non-null event-loop delay when perf_hooks is available', () => {
    const service = new ServerStatsService(config());
    const stats = service.getStats();
    // Node always ships monitorEventLoopDelay in supported versions, so this is a
    // finite, non-negative number in the test runtime.
    expect(stats.eventLoopDelayMs).not.toBeNull();
    if (stats.eventLoopDelayMs !== null) {
      expect(stats.eventLoopDelayMs).toBeGreaterThanOrEqual(0);
    }
    service.onApplicationShutdown();
  });

  it('does not throw when shut down twice', () => {
    const service = new ServerStatsService(config());
    expect(() => {
      service.onApplicationShutdown();
      service.onApplicationShutdown();
    }).not.toThrow();
  });

  describe('history', () => {
    it('starts empty', () => {
      const service = new ServerStatsService(config());
      expect(service.getHistory().samples).toEqual([]);
      service.onApplicationShutdown();
    });

    it('appends a CPU/mem sample on each getStats call', () => {
      const service = new ServerStatsService(config());
      service.getStats();
      service.getStats();
      const history = service.getHistory();
      expect(history.samples).toHaveLength(2);
      const sample = history.samples[0];
      expect(Number.isFinite(sample?.atMs)).toBe(true);
      expect(Number.isFinite(sample?.rssMb)).toBe(true);
      expect(Number.isFinite(sample?.heapUsedMb)).toBe(true);
      expect(Number.isFinite(sample?.cpuPercent)).toBe(true);
      service.onApplicationShutdown();
    });

    it('caps the ring buffer at maxSamples, evicting the oldest', () => {
      const service = new ServerStatsService(config(), { maxSamples: 3 });
      for (let i = 0; i < 5; i++) service.getStats();
      const history = service.getHistory();
      expect(history.samples).toHaveLength(3);
      // Monotonic non-decreasing timestamps (oldest first).
      const times = history.samples.map((s) => s.atMs);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      service.onApplicationShutdown();
    });
  });
});
