import { constants } from 'node:perf_hooks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeCollector } from './runtime-collector.js';

/**
 * Every platform reading the collector takes is routed through this object so a
 * spec can hand it a histogram that reports a known mean, or an instrument that
 * refuses to start. `beforeEach` restores a state in which all four sub-sections
 * are measurable, because that is the only state Observe's collector accepts.
 */
const hooks = vi.hoisted(() => ({
  monitorEventLoopDelay: null as null | ((options: any) => any),
  eventLoopUtilization: null as null | ((a?: any, b?: any) => any),
  observeThrows: null as null | Error,
  observers: [] as any[],
}));

vi.mock('node:perf_hooks', async () => {
  const actual = await vi.importActual<typeof import('node:perf_hooks')>('node:perf_hooks');

  class FakeObserver {
    disconnected = false;
    observed: any[] = [];
    constructor(readonly callback: (list: any) => void) {
      hooks.observers.push(this);
    }
    observe(options: any): void {
      if (hooks.observeThrows) throw hooks.observeThrows;
      this.observed.push(options);
    }
    disconnect(): void {
      this.disconnected = true;
    }
    emit(entries: any[]): void {
      this.callback({ getEntries: () => entries });
    }
  }

  return {
    ...actual,
    PerformanceObserver: FakeObserver,
    monitorEventLoopDelay: (options: any) =>
      hooks.monitorEventLoopDelay
        ? hooks.monitorEventLoopDelay(options)
        : actual.monitorEventLoopDelay(options),
    performance: {
      eventLoopUtilization: (a?: any, b?: any) =>
        hooks.eventLoopUtilization
          ? hooks.eventLoopUtilization(a, b)
          : actual.performance.eventLoopUtilization(a, b),
    },
  };
});

function fakeHistogram(mean: number | (() => number)) {
  return {
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    unref: vi.fn(),
    get mean(): number {
      return typeof mean === 'function' ? mean() : mean;
    },
  };
}

function gcEntry(duration: number, kind?: number) {
  return { duration, detail: kind === undefined ? undefined : { kind } };
}

/** A clock the spec advances by hand, so an interval is exactly as long as it says. */
function stepClock(startAt = 1_000, stepMs = 1_000) {
  let now = startAt;
  return {
    clock: () => now,
    advance(by = stepMs) {
      now += by;
    },
  };
}

function testLogger() {
  const warn = vi.fn();
  return {
    warn,
    linesMatching: (pattern: RegExp) =>
      warn.mock.calls.map(([message]) => String(message)).filter((line) => pattern.test(line)),
  };
}

/** The one warning that means "measured, but not completely enough to send". */
const PARTIAL_WARNING = /incomplete/;

function allNumbers(value: unknown, path = '$'): Array<[string, number]> {
  if (typeof value === 'number') return [[path, value]];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    allNumbers(child, `${path}.${key}`),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  // A real histogram has no mean until it has sampled, so the default is a fake
  // that already reports one — otherwise every happy-path collect is a null.
  hooks.monitorEventLoopDelay = () => fakeHistogram(1_000_000);
  hooks.eventLoopUtilization = null;
  hooks.observeThrows = null;
  hooks.observers.length = 0;
});

describe('RuntimeCollector', () => {
  it('returns null before start', () => {
    expect(new RuntimeCollector().collect()).toBeNull();
  });

  it('returns all four sections or nothing, because Observe 500s on a partial runtime', () => {
    const time = stepClock();
    const collector = new RuntimeCollector({ clock: time.clock });
    collector.start();
    time.advance();

    const metrics = collector.collect();
    collector.stop();

    expect(metrics).not.toBeNull();
    expect(Object.keys(metrics ?? {}).sort()).toEqual(['c', 'e', 'g', 'm']);
  });

  it('fills all four sections from the real instruments once the histogram has sampled', async () => {
    hooks.monitorEventLoopDelay = null;

    const collector = new RuntimeCollector();
    collector.start();
    await sleep(150);

    const metrics = collector.collect();
    collector.stop();

    expect(Object.keys(metrics ?? {}).sort()).toEqual(['c', 'e', 'g', 'm']);
    expect(metrics?.e?.l).toBeGreaterThan(0);
  });

  it('reports memory and cpu on the first collect after start', () => {
    const time = stepClock();
    const collector = new RuntimeCollector({ clock: time.clock });
    collector.start();
    time.advance(500);

    const metrics = collector.collect();
    collector.stop();

    expect(metrics).not.toBeNull();
    expect(metrics?.m?.ht).toBeGreaterThan(0);
    expect(metrics?.m?.hu).toBeGreaterThan(0);
    expect(metrics?.m?.r).toBeGreaterThan(0);
    expect(Number.isInteger(metrics?.m?.r)).toBe(true);
    expect(metrics?.c).toBeDefined();
    expect(metrics?.c?.u).toBeGreaterThanOrEqual(0);
    expect(metrics?.c?.s).toBeGreaterThanOrEqual(0);
  });

  it('keeps every percentage finite and non-negative', () => {
    const time = stepClock();
    hooks.monitorEventLoopDelay = () => fakeHistogram(2_500_000);
    const collector = new RuntimeCollector({ clock: time.clock });
    collector.start();
    time.advance(1_000);

    const metrics = collector.collect();
    collector.stop();

    expect(metrics?.c?.p).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(metrics?.c?.p)).toBe(true);
    expect(metrics?.m?.p).toBeGreaterThanOrEqual(0);
    expect(metrics?.m?.p).toBeLessThanOrEqual(100);
    expect(metrics?.e?.l).toBe(2.5);
    expect(metrics?.e?.u).toBeGreaterThanOrEqual(0);
    expect(metrics?.e?.u).toBeLessThanOrEqual(1);
  });

  it('derives the cpu percentage from the injected clock and does not cap it at 100', () => {
    const time = stepClock();
    const cpuUsage = vi
      .spyOn(process, 'cpuUsage')
      // 3 200 000 µs of CPU over a 1 000 ms interval: 3.2 busy cores.
      .mockImplementation(() => ({ user: 2_000_000, system: 1_200_000 }) as NodeJS.CpuUsage);

    const collector = new RuntimeCollector({ clock: time.clock });
    collector.start();
    time.advance(1_000);
    const metrics = collector.collect();
    collector.stop();
    cpuUsage.mockRestore();

    expect(metrics?.c?.u).toBe(2_000_000);
    expect(metrics?.c?.s).toBe(1_200_000);
    expect(metrics?.c?.p).toBe(320);
  });

  it('keeps the cpu percentage finite when no time passed between collects', () => {
    const collector = new RuntimeCollector({ clock: () => 5_000 });
    collector.start();

    const metrics = collector.collect();
    collector.stop();

    expect(metrics?.c?.p).toBe(0);
  });

  it('accumulates gc entries and resets the totals between collects', () => {
    const time = stepClock();
    const collector = new RuntimeCollector({ clock: time.clock });
    collector.start();

    const observer = hooks.observers[0];
    observer.emit([
      gcEntry(1.5, constants.NODE_PERFORMANCE_GC_MINOR),
      gcEntry(4.25, constants.NODE_PERFORMANCE_GC_MAJOR),
      gcEntry(0.25, constants.NODE_PERFORMANCE_GC_INCREMENTAL),
      gcEntry(0.5, constants.NODE_PERFORMANCE_GC_WEAKCB),
    ]);

    time.advance();
    const first = collector.collect();
    time.advance();
    const second = collector.collect();
    collector.stop();

    expect(first?.g?.c).toBe(4);
    expect(first?.g?.td).toBe(6.5);
    expect(first?.g?.b).toEqual({ m: 1, j: 1, i: 1 });
    expect(second?.g).toEqual({ c: 0, td: 0, b: { m: 0, j: 0, i: 0 } });
  });

  it('subscribes to gc unbuffered', () => {
    const collector = new RuntimeCollector();
    collector.start();
    const observer = hooks.observers[0];
    collector.stop();

    expect(observer.observed).toEqual([{ entryTypes: ['gc'], buffered: false }]);
  });

  it('unrefs the delay histogram so it cannot hold the process open', () => {
    const histogram = fakeHistogram(1_000_000);
    hooks.monitorEventLoopDelay = () => histogram;

    const collector = new RuntimeCollector();
    collector.start();
    collector.stop();

    expect(histogram.unref).toHaveBeenCalledTimes(1);
    expect(histogram.enable).toHaveBeenCalledTimes(1);
    expect(histogram.disable).toHaveBeenCalledTimes(1);
  });

  it('resets the delay histogram so each snapshot describes its own interval', () => {
    const histogram = fakeHistogram(1_000_000);
    hooks.monitorEventLoopDelay = () => histogram;
    const time = stepClock();

    const collector = new RuntimeCollector({ clock: time.clock });
    collector.start();
    time.advance();
    collector.collect();
    time.advance();
    collector.collect();
    collector.stop();

    expect(histogram.reset).toHaveBeenCalledTimes(2);
  });

  it('is idempotent on start and stop, and disconnects the observer', () => {
    const collector = new RuntimeCollector();
    collector.start();
    collector.start();

    expect(hooks.observers).toHaveLength(1);
    const observer = hooks.observers[0];

    collector.stop();
    expect(observer.disconnected).toBe(true);
    expect(() => collector.stop()).not.toThrow();
    expect(collector.collect()).toBeNull();
  });

  it('returns null when the delay monitor is unavailable', () => {
    hooks.monitorEventLoopDelay = () => {
      throw new Error('monitorEventLoopDelay unsupported');
    };
    const logger = testLogger();
    const time = stepClock();

    const collector = new RuntimeCollector({ clock: time.clock, logger });
    collector.start();
    time.advance();
    const metrics = collector.collect();
    collector.stop();

    expect(metrics).toBeNull();
    expect(logger.linesMatching(/eventLoopDelay/)).toHaveLength(1);
    expect(logger.linesMatching(PARTIAL_WARNING)).toHaveLength(1);
  });

  it('returns null when the gc observer refuses to attach', () => {
    hooks.observeThrows = new Error('gc entries unsupported');
    const logger = testLogger();
    const time = stepClock();

    const collector = new RuntimeCollector({ clock: time.clock, logger });
    collector.start();
    time.advance();
    const metrics = collector.collect();
    collector.stop();

    expect(metrics).toBeNull();
    // The observer was still constructed and `observe` still attempted; it is
    // the runtime that said no.
    expect(hooks.observers).toHaveLength(1);
    expect(logger.linesMatching(/gc/)).toHaveLength(1);
    expect(logger.linesMatching(PARTIAL_WARNING)).toHaveLength(1);
  });

  it('warns once per failing probe and once for the partial snapshot, not once per flush', () => {
    hooks.eventLoopUtilization = () => {
      throw new Error('eventLoopUtilization unsupported');
    };
    const logger = testLogger();
    const time = stepClock();

    const collector = new RuntimeCollector({ clock: time.clock, logger });
    collector.start();
    for (let i = 0; i < 3; i += 1) {
      time.advance();
      expect(collector.collect()).toBeNull();
    }
    collector.stop();

    expect(logger.linesMatching(/eventLoopUtilization/)).toHaveLength(1);
    expect(logger.linesMatching(PARTIAL_WARNING)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('survives a collector built without a logger', () => {
    hooks.eventLoopUtilization = () => {
      throw new Error('nope');
    };
    const collector = new RuntimeCollector();
    collector.start();

    expect(() => collector.collect()).not.toThrow();
    expect(collector.collect()).toBeNull();
    collector.stop();
  });

  it('withholds a snapshot with a NaN lag and sends the next one instead', () => {
    let mean = Number.NaN;
    hooks.monitorEventLoopDelay = () => fakeHistogram(() => mean);
    const time = stepClock();

    const collector = new RuntimeCollector({ clock: time.clock });
    collector.start();
    time.advance();
    expect(collector.collect()).toBeNull();

    mean = 3_000_000;
    time.advance();
    const metrics = collector.collect();
    collector.stop();

    expect(Object.keys(metrics ?? {}).sort()).toEqual(['c', 'e', 'g', 'm']);
    expect(metrics?.e?.l).toBe(3);
  });

  it('clamps a utilization reported outside 0..1', () => {
    hooks.eventLoopUtilization = () => ({ idle: 0, active: 0, utilization: 1.4 });
    const time = stepClock();

    const collector = new RuntimeCollector({ clock: time.clock });
    collector.start();
    time.advance();
    const metrics = collector.collect();
    collector.stop();

    expect(metrics?.e?.u).toBe(1);
  });

  it('never emits a non-finite number in any section', () => {
    hooks.monitorEventLoopDelay = () => fakeHistogram(1_234_567);
    hooks.eventLoopUtilization = () => ({
      idle: Number.NaN,
      active: Number.NaN,
      utilization: 0.42,
    });
    const time = stepClock();

    const collector = new RuntimeCollector({ clock: time.clock });
    collector.start();
    const observer = hooks.observers[0];
    observer.emit([gcEntry(Number.NaN), gcEntry(2, constants.NODE_PERFORMANCE_GC_MINOR)]);
    time.advance();

    const metrics = collector.collect();
    collector.stop();

    const numbers = allNumbers(metrics);
    expect(numbers.length).toBeGreaterThan(10);
    for (const [path, value] of numbers) {
      expect(Number.isFinite(value), `${path} = ${value}`).toBe(true);
    }
    expect(metrics?.g?.c).toBe(1);
  });
});
