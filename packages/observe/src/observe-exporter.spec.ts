import { gunzipSync } from 'node:zlib';
import type { Entry } from '@dudousxd/nestjs-telescope';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObserveExporter } from './observe-exporter.js';
import type { FetchLike, ObserveExporterOptions } from './observe-options.js';
import type { WireRuntimeMetrics } from './wire/telemetry-wire.js';
import type { WireTelemetryBatch } from './wire/telemetry-wire.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * A complete snapshot, which is the only kind Observe accepts — a partial
 * `runtime` makes their collector answer 500. The real collector reads the
 * event-loop histogram, which needs wall time to take a sample and therefore
 * cannot produce one under this suite's fake timers; the platform probes are
 * covered by the collector's own specs.
 */
const RUNTIME: WireRuntimeMetrics = {
  c: { u: 1000, s: 500, p: 1.5 },
  m: { r: 100, ht: 80, hu: 40, e: 10, ab: 5, p: 50 },
  g: { c: 0, td: 0, b: { m: 0, j: 0, i: 0 } },
  e: { l: 1.2, u: 0.05 },
};

vi.mock('./runtime/runtime-collector.js', () => ({
  RuntimeCollector: class {
    start() {}
    stop() {}
    collect() {
      return RUNTIME;
    }
  },
}));

function entry(type: string, content: unknown, overrides: Partial<Entry> = {}): Entry {
  return {
    id: `e-${type}-${overrides.sequence ?? 0}`,
    batchId: 'batch-1',
    type,
    familyHash: null,
    content,
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i1',
    traceId: null,
    spanId: null,
    createdAt: new Date(START),
    ...overrides,
  } as Entry;
}

function requestRoot(overrides: Partial<Entry> = {}): Entry {
  return entry(
    'request',
    {
      method: 'GET',
      uri: '/orders/42',
      headers: {},
      payload: null,
      user: null,
      response: null,
      statusCode: 200,
      ip: null,
      memoryMb: null,
    },
    { sequence: 9, durationMs: 30, ...overrides },
  );
}

/**
 * A tight `setImmediate` loop runs in the check phase and can starve the poll
 * phase, where libuv delivers zlib's thread-pool completion — the gzip that
 * every send awaits. Yielding through a REAL timer (captured before the fake
 * ones are installed) forces a full loop turn instead.
 */
const realSetTimeout = globalThis.setTimeout;

function yieldToIo(): Promise<void> {
  return new Promise((resolve) => {
    realSetTimeout(resolve, 0);
  });
}

/** Full loop turns, so the gzip behind every send can complete. */
async function turns(count = 12): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await yieldToIo();
  }
}

describe('ObserveExporter', () => {
  let sent: WireTelemetryBatch[];
  let fetchMock: ReturnType<typeof vi.fn>;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    sent = [];
    now = START;
  });

  /**
   * `Date` is deliberately left real so zlib's thread-pool callbacks still
   * settle, so the exporter's injected clock has to be advanced alongside the
   * fake timers — the assembler's grace window reads the clock, not the timer.
   */
  async function advance(ms: number, settleTurns = 6): Promise<void> {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
    await turns(settleTurns);
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function build(overrides: Partial<ObserveExporterOptions> = {}): ObserveExporter {
    const fetchImpl: FetchLike = async (_url, init) => {
      sent.push(JSON.parse(gunzipSync(init.body).toString('utf8')) as WireTelemetryBatch);
      return { ok: true, status: 200, text: async () => '' };
    };
    fetchMock = vi.fn(fetchImpl);
    return new ObserveExporter({
      appKey: 'k',
      appSecret: 's',
      serviceId: 'orders-api',
      fetch: fetchMock as unknown as FetchLike,
      clock: () => now,
      logger: { warn: () => {} },
      ...overrides,
    });
  }

  describe('configuration', () => {
    it('refuses to start without credentials', () => {
      expect(() => build({ appKey: '' })).toThrow(/appKey/);
      expect(() => build({ serviceId: '  ' })).toThrow(/serviceId/);
    });

    it('does not hold the process open', () => {
      const exporter = build();
      // An unref'd interval is the difference between a CLI that exits and one
      // that hangs for the flush period after its work is done.
      expect(vi.getTimerCount()).toBe(1);
      return exporter.close();
    });
  });

  describe('include gating', () => {
    it('never buffers an entry whose section is off', () => {
      const exporter = build({ include: { logs: false } });
      exporter.observeFlush([
        entry('log', { level: 'log', message: 'hi', context: null }),
        entry('query', { sql: 'select 1', bindings: [], connection: null, slow: false }),
      ]);
      expect(exporter.metrics.entriesFiltered).toBe(1);
      expect(exporter.metrics.entriesAccepted).toBe(1);
      return exporter.close();
    });

    it('gives the host filter the last word', () => {
      const exporter = build({ filter: (e) => e.type !== 'cache' });
      exporter.observeFlush([
        entry('cache', { operation: 'get', key: 'k', hit: true }),
        requestRoot(),
      ]);
      expect(exporter.metrics.entriesFiltered).toBe(1);
      return exporter.close();
    });
  });

  describe('assembly across flushes', () => {
    it('joins a request with children that arrived in an earlier flush', async () => {
      const exporter = build();
      // The order the Recorder really produces: children during the handler,
      // the request itself only once the response finished.
      // The request ran [START - 30, START]; the query finished 10ms before the
      // response after 4ms of work, so it began 16ms into the request.
      exporter.observeFlush([
        entry(
          'query',
          { sql: 'select 1', bindings: [], connection: null, slow: false },
          {
            sequence: 1,
            durationMs: 4,
            createdAt: new Date(START - 10),
          },
        ),
      ]);
      exporter.observeFlush([requestRoot()]);

      await exporter.close();
      await turns();

      expect(sent).toHaveLength(1);
      const snapshot = sent[0]?.snapshots?.[0];
      expect(snapshot?.op).toBe('GET /orders/:id');
      expect(snapshot?.t).toHaveLength(1);
      expect(snapshot?.t?.[0]?.n).toBe('db.query');
      expect(snapshot?.t?.[0]?.so).toBe(16);
    });

    it('holds a batch until its grace window elapses', async () => {
      // Runtime and metrics have their own heartbeat that would POST regardless;
      // this test is about when a BATCH becomes eligible.
      const exporter = build({
        batchGraceMs: 5_000,
        flushIntervalMs: 1_000,
        include: { runtime: false, metrics: false },
      });
      exporter.observeFlush([requestRoot()]);

      await advance(2_000);
      expect(fetchMock).not.toHaveBeenCalled();

      await advance(6_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await exporter.close();
    });
  });

  describe('payload', () => {
    it('routes logs to `logs[]` rather than onto the span tree', async () => {
      const exporter = build();
      exporter.observeFlush([
        requestRoot(),
        entry(
          'log',
          { level: 'WARN', message: 'careful', context: 'OrdersService' },
          {
            sequence: 2,
          },
        ),
      ]);

      await exporter.close();
      await turns();

      const payload = sent[0];
      expect(payload?.logs).toHaveLength(1);
      expect(payload?.logs?.[0]?.text).toBe('careful');
      expect(payload?.logs?.[0]?.level).toBe('warn');
      expect(payload?.snapshots?.[0]?.t).toEqual([]);
    });

    it('stamps the service identity and omits empty sections', async () => {
      const exporter = build({ serviceVersion: 'abc123' });
      exporter.observeFlush([requestRoot()]);

      await exporter.close();
      await turns();

      const payload = sent[0];
      expect(payload?.serviceId).toBe('orders-api');
      expect(payload?.serviceVersion).toBe('abc123');
      expect(payload).not.toHaveProperty('jobs');
      expect(payload).not.toHaveProperty('logs');
    });

    it('never emits the `st` key their collector rejects', async () => {
      const exporter = build();
      exporter.observeFlush([requestRoot()]);

      await exporter.close();
      await turns();

      expect(JSON.stringify(sent[0])).not.toContain('"st"');
    });

    it('splits oversized buffers across several requests', async () => {
      const exporter = build({ maxRecordsPerRequest: 2 });
      for (let i = 0; i < 5; i += 1) {
        exporter.observeFlush([requestRoot({ batchId: `batch-${i}`, id: `req-${i}` })]);
      }

      await exporter.close();
      await turns(30);

      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      const total = sent.reduce((sum, p) => sum + (p.snapshots?.length ?? 0), 0);
      expect(total).toBe(5);
      for (const payload of sent) {
        expect(payload.snapshots?.length ?? 0).toBeLessThanOrEqual(2);
      }
    });

    it('sends nothing when there is nothing to send', async () => {
      const exporter = build({ include: { runtime: false, metrics: false } });
      await advance(30_000);
      expect(fetchMock).not.toHaveBeenCalled();
      await exporter.close();
    });
  });

  describe('runtime and custom metrics', () => {
    it('reports a process snapshot even with no traffic at all', async () => {
      const exporter = build({ include: { requests: false, jobs: false, logs: false } });

      await exporter.close();
      await turns();

      expect(sent).toHaveLength(1);
      const runtime = sent[0]?.runtime;
      // All four sections, always: their collector 500s on a partial one.
      expect(Object.keys(runtime ?? {}).sort()).toEqual(['c', 'e', 'g', 'm']);
      expect(exporter.metrics.runtimeSnapshotsSent).toBe(1);
    });

    it('holds the next snapshot until the runtime interval elapses', async () => {
      const exporter = build({ runtimeIntervalMs: 60_000, flushIntervalMs: 1_000 });

      await advance(5_000);
      const first = sent.filter((p) => p.runtime !== undefined).length;
      await advance(20_000);
      expect(sent.filter((p) => p.runtime !== undefined).length).toBe(first);

      await advance(45_000);
      expect(sent.filter((p) => p.runtime !== undefined).length).toBe(first + 1);

      await exporter.close();
    });

    it('counts every record, including ones sampling would drop', async () => {
      const exporter = build({ sampleRate: 0 });
      // observeRecord fires before sampling; observeFlush after. Only the first
      // can answer "how many requests did this process actually serve?".
      for (let i = 0; i < 5; i += 1) {
        exporter.observeRecord({ type: 'request', content: { statusCode: 200 }, durationMs: 10 });
      }

      await exporter.close();
      await turns();

      const custom = sent.flatMap((p) => p.custom ?? []);
      const counter = custom.find((m) => m.t === 'counter');
      expect(counter?.n).toBe('telescope.entries');
      expect(Object.values(counter?.v ?? {}).reduce((a, b) => a + b, 0)).toBe(5);
    });

    it('omits both sections when they are switched off', async () => {
      const exporter = build({ include: { runtime: false, metrics: false } });
      exporter.observeRecord({ type: 'request', content: {}, durationMs: 1 });
      exporter.observeFlush([requestRoot()]);

      await exporter.close();
      await turns();

      expect(sent[0]).not.toHaveProperty('runtime');
      expect(sent[0]).not.toHaveProperty('custom');
    });

    it('does not POST a cumulative counter on every idle flush', async () => {
      const exporter = build({ runtimeIntervalMs: 60_000, flushIntervalMs: 1_000 });
      exporter.observeRecord({ type: 'request', content: {}, durationMs: 1 });

      // The heartbeat sends one; the eleven idle flushes after it send nothing.
      await advance(1_000);
      const afterFirst = sent.length;
      await advance(11_000);

      expect(sent.length).toBe(afterFirst);
      await exporter.close();
    });
  });

  describe('sampling', () => {
    it('drops clean batches but keeps the failing one', async () => {
      const exporter = build({ sampleRate: 0 });
      exporter.observeFlush([requestRoot({ batchId: 'clean', id: 'r-clean' })]);
      exporter.observeFlush([
        requestRoot({ batchId: 'broken', id: 'r-broken' }),
        entry(
          'exception',
          { class: 'Error', message: 'boom', stack: null, context: {} },
          {
            batchId: 'broken',
            tags: ['failed'],
            sequence: 3,
          },
        ),
      ]);

      await exporter.close();
      await turns();

      expect(exporter.metrics.batchesSampledOut).toBe(1);
      const snapshots = sent.flatMap((p) => p.snapshots ?? []);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.e?.message).toBe('boom');
    });
  });

  describe('shutdown', () => {
    it('flushes what is still held and stops the timer', async () => {
      const exporter = build({ batchGraceMs: 60_000 });
      exporter.observeFlush([requestRoot()]);

      await exporter.close();
      await turns();

      // The grace window has not elapsed, so only close() can have emitted this.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('is idempotent and ignores entries afterwards', async () => {
      const exporter = build({ include: { runtime: false, metrics: false } });
      await exporter.close();
      await exporter.close();
      exporter.observeFlush([requestRoot()]);
      await turns(4);
      expect(exporter.metrics.entriesAccepted).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
