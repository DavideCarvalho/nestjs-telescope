// packages/otel/src/span-processor.spec.ts
import {
  type RecordInput,
  type SpanContent,
  isTelescopeSpanProcessorActive,
  markCoveredByTelescope,
  reportCoveredOutcome,
  runAsTelescopeWork,
  runCoveredByTelescope,
  telescopeRuntime,
} from '@dudousxd/nestjs-telescope';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ReadableSpanLike,
  type TelescopeSpanProcessorOptions,
  telescopeSpanProcessor,
} from './span-processor.js';

const SERVER = 1;
const CLIENT = 2;

let nextSpanId = 1;

interface FakeSpanInit {
  name?: string;
  kind?: number;
  traceId?: string;
  parent?: ReadableSpanLike;
  scope?: string;
  attributes?: Record<string, unknown>;
  status?: { code: number; message?: string };
  startMs?: number;
  durationMs?: number;
}

function span(init: FakeSpanInit = {}): ReadableSpanLike {
  const spanId = (nextSpanId++).toString(16).padStart(16, '0');
  const traceId = init.traceId ?? init.parent?.spanContext().traceId ?? 'a'.repeat(32);
  const startMs = init.startMs ?? 1_700_000_000_000;
  const durationMs = init.durationMs ?? 12.5;
  return {
    name: init.name ?? 'work',
    kind: init.kind ?? 0,
    spanContext: () => ({ traceId, spanId }),
    parentSpanContext:
      init.parent !== undefined ? { spanId: init.parent.spanContext().spanId } : undefined,
    startTime: [Math.floor(startMs / 1000), (startMs % 1000) * 1e6],
    duration: [Math.floor(durationMs / 1000), Math.round((durationMs % 1000) * 1e6)],
    status: init.status ?? { code: 0 },
    attributes: init.attributes ?? {},
    events: [],
    instrumentationScope: { name: init.scope ?? 'app' },
  };
}

let recorded: RecordInput<SpanContent>[] = [];
let releases: Array<() => void> = [];

function boot(): void {
  const runtime = telescopeRuntime();
  runtime.record = (input) => recorded.push(input as RecordInput<SpanContent>);
  runtime.isPaused = () => false;
  runtime.selfPath = '/telescope';
  runtime.isSampled = () => false;
}

function cover(...operations: Array<'request' | 'query' | 'redis'>): void {
  for (const operation of operations) releases.push(markCoveredByTelescope(operation));
}

/** Run a span through the processor the way the SDK does: start, then end. */
function run(
  processor: ReturnType<typeof telescopeSpanProcessor>,
  ...spans: ReadableSpanLike[]
): void {
  for (const s of spans) processor.onStart(s, undefined);
  for (const s of [...spans].reverse()) processor.onEnd(s);
}

function names(): string[] {
  return recorded.map((input) => input.content.name);
}

function make(options?: TelescopeSpanProcessorOptions) {
  return telescopeSpanProcessor(options);
}

beforeEach(() => {
  recorded = [];
  boot();
});

afterEach(() => {
  for (const release of releases) release();
  releases = [];
  const runtime = telescopeRuntime();
  runtime.record = null;
  runtime.selfPath = null;
});

describe('telescopeSpanProcessor', () => {
  it('records an ended span as a `span` entry in its trace', () => {
    const processor = make();
    const s = span({
      name: 'render invoice',
      traceId: 'b'.repeat(32),
      attributes: { 'invoice.id': 42 },
      status: { code: 2, message: 'boom' },
      startMs: 1_700_000_000_250,
    });
    run(processor, s);

    expect(recorded).toHaveLength(1);
    const input = recorded[0]!;
    expect(input).toMatchObject({
      type: 'span',
      traceId: 'b'.repeat(32),
      spanId: s.spanContext().spanId,
      familyHash: 'app:render invoice',
      tags: ['scope:app', 'kind:internal', 'failed'],
      durationMs: 12.5,
      content: {
        name: 'render invoice',
        kind: 'internal',
        scope: 'app',
        parentSpanId: null,
        status: 'error',
        statusMessage: 'boom',
        failed: true,
        attributes: { 'invoice.id': 42 },
      },
    });
    expect(input.startedAt?.getTime()).toBe(1_700_000_000_250);
    expect(isTelescopeSpanProcessorActive()).toBe(true);
  });

  it('records nothing before Telescope boots or while it is paused', () => {
    const processor = make();
    telescopeRuntime().record = null;
    run(processor, span());
    expect(recorded).toEqual([]);

    boot();
    telescopeRuntime().isPaused = () => true;
    run(processor, span());
    expect(recorded).toEqual([]);
  });

  it('skips the HTTP server span while the request middleware records requests', () => {
    const processor = make();
    const server = span({
      name: 'GET',
      kind: SERVER,
      scope: '@opentelemetry/instrumentation-http',
      attributes: { 'url.path': '/orders' },
    });
    const child = span({ name: 'load orders', parent: server });
    cover('request');
    run(processor, server, child);
    expect(names()).toEqual(['load orders']);
  });

  it('records the HTTP server span when nothing records requests', () => {
    const processor = make();
    run(
      processor,
      span({ name: 'GET', kind: SERVER, scope: '@opentelemetry/instrumentation-http' }),
    );
    expect(names()).toEqual(['GET']);
  });

  it('keeps outgoing HTTP client spans (only the server side is covered)', () => {
    const processor = make();
    cover('request');
    run(
      processor,
      span({ name: 'GET', kind: CLIENT, scope: '@opentelemetry/instrumentation-http' }),
    );
    expect(names()).toEqual(['GET']);
  });

  it('skips DB driver spans and the spans under them while a query watcher is on', () => {
    const processor = make();
    const parent = span({ name: 'checkout' });
    const pg = span({
      name: 'pg.query:SELECT',
      parent,
      scope: '@opentelemetry/instrumentation-pg',
    });
    const socket = span({
      name: 'tcp.connect',
      parent: pg,
      scope: '@opentelemetry/instrumentation-net',
    });
    cover('query');
    run(processor, parent, pg, socket);
    expect(names()).toEqual(['checkout']);
  });

  it("skips Prisma's spans (tracer `prisma`) while the Prisma watcher is on", () => {
    const processor = make();
    cover('query');
    run(processor, span({ name: 'prisma:engine:db_query', scope: 'prisma' }));
    expect(names()).toEqual([]);
  });

  it('records DB driver spans when no query watcher is on', () => {
    const processor = make();
    const pg = span({ name: 'pg.query:SELECT', scope: '@opentelemetry/instrumentation-pg' });
    const socket = span({
      name: 'tcp.connect',
      parent: pg,
      scope: '@opentelemetry/instrumentation-net',
    });
    cover('redis');
    run(processor, pg, socket);
    expect(names().sort()).toEqual(['pg.query:SELECT', 'tcp.connect']);
  });

  it('skips redis spans while the redis watcher is on', () => {
    const processor = make();
    cover('redis');
    run(
      processor,
      span({ name: 'get', scope: '@opentelemetry/instrumentation-ioredis' }),
      span({ name: 'set', scope: '@opentelemetry/instrumentation-redis' }),
    );
    expect(names()).toEqual([]);
  });

  it('skips the undici span of a fetch the http-client watcher records, not other fetches', () => {
    const processor = make();
    const covered = span({
      name: 'GET covered',
      kind: CLIENT,
      scope: '@opentelemetry/instrumentation-undici',
    });
    runCoveredByTelescope(() => processor.onStart(covered, undefined));
    processor.onEnd(covered);
    run(
      processor,
      span({ name: 'GET plain', kind: CLIENT, scope: '@opentelemetry/instrumentation-undici' }),
    );
    expect(names()).toEqual(['GET plain']);
  });

  it('skips the http span of an axios call the watcher records, not other http calls', () => {
    const processor = make();
    const http = '@opentelemetry/instrumentation-http';
    const axiosCall = span({ name: 'GET axios', kind: CLIENT, scope: http });
    const socket = span({ name: 'tcp.connect', parent: axiosCall, scope: 'net' });
    runCoveredByTelescope(() => {
      processor.onStart(axiosCall, undefined);
      processor.onStart(socket, undefined);
    });
    processor.onEnd(socket);
    processor.onEnd(axiosCall);
    // e.g. the AWS SDK: http.request outside the watcher.
    run(processor, span({ name: 'PUT s3', kind: CLIENT, scope: http }));
    expect(names()).toEqual(['PUT s3']);
  });

  describe('when sampling can drop the watcher entries', () => {
    const pg = '@opentelemetry/instrumentation-pg';

    beforeEach(() => {
      telescopeRuntime().isSampled = () => true;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows a covered span only when its entry was sampled out', () => {
      const processor = make();
      cover('query');
      const kept = span({ name: 'SELECT kept', scope: pg });
      const socket = span({ name: 'tcp.connect', parent: kept, scope: 'net' });
      run(processor, kept, socket);
      reportCoveredOutcome('query', true);
      const dropped = span({ name: 'SELECT dropped', scope: pg });
      run(processor, dropped);
      reportCoveredOutcome('query', false);
      expect(names()).toEqual(['SELECT dropped']);
    });

    it('pairs a decision that arrives before the span ends (TypeORM logs first)', () => {
      const processor = make();
      cover('query');
      reportCoveredOutcome('query', false);
      reportCoveredOutcome('query', true);
      run(processor, span({ name: 'SELECT 1', scope: pg }));
      run(processor, span({ name: 'SELECT 2', scope: pg }));
      expect(names()).toEqual(['SELECT 1']);
    });

    it('pairs per operation, and ignores types no watcher covers', () => {
      const processor = make();
      cover('query', 'redis');
      run(processor, span({ name: 'get', scope: '@opentelemetry/instrumentation-ioredis' }));
      run(processor, span({ name: 'SELECT', scope: pg }));
      reportCoveredOutcome('log', false);
      reportCoveredOutcome('query', true);
      reportCoveredOutcome('redis', false);
      expect(names()).toEqual(['get']);
    });

    it('shows a held span the watcher never records (a call it does not see)', () => {
      vi.useFakeTimers();
      const processor = make();
      cover('query');
      run(processor, span({ name: 'raw SELECT', scope: pg }));
      expect(names()).toEqual([]);
      vi.advanceTimersByTime(3_000);
      expect(names()).toEqual(['raw SELECT']);
    });

    it('holds covered http client spans the same way', () => {
      const processor = make();
      const call = span({
        name: 'GET',
        kind: CLIENT,
        scope: '@opentelemetry/instrumentation-undici',
      });
      runCoveredByTelescope(() => processor.onStart(call, undefined));
      processor.onEnd(call);
      reportCoveredOutcome('http_client', false);
      expect(names()).toEqual(['GET']);
    });
  });

  it("skips Telescope's own spans and work", () => {
    const processor = make();
    run(processor, span({ scope: 'telescope', name: 'request' }));
    const own = span({ name: 'INSERT entries' });
    const under = span({ name: 'socket', parent: own });
    runAsTelescopeWork(() => processor.onStart(own, undefined));
    processor.onStart(under, undefined);
    processor.onEnd(under);
    processor.onEnd(own);
    expect(names()).toEqual([]);
  });

  it('skips every span of a request to the dashboard', () => {
    const processor = make();
    const server = span({
      name: 'GET',
      kind: SERVER,
      scope: '@opentelemetry/instrumentation-http',
      attributes: { 'url.path': '/telescope/api/entries' },
    });
    const child = span({ name: 'controller', parent: server });
    run(processor, server, child);
    // `/telescopes` is not the dashboard.
    run(
      processor,
      span({
        name: 'GET other',
        kind: SERVER,
        traceId: 'c'.repeat(32),
        scope: '@opentelemetry/instrumentation-http',
        attributes: { 'url.path': '/telescopes' },
      }),
    );
    expect(names()).toEqual(['GET other']);
  });

  it('caps the spans of one trace at maxSpansPerTrace', () => {
    const processor = make({ maxSpansPerTrace: 2 });
    run(processor, span({ name: 'a' }), span({ name: 'b' }), span({ name: 'c' }));
    run(processor, span({ name: 'other trace', traceId: 'd'.repeat(32) }));
    expect(names()).toHaveLength(3);
    expect(names()).toContain('other trace');
  });

  it('caps attribute count and string length', () => {
    const processor = make({ maxAttributes: 2, maxAttributeLength: 16 });
    run(processor, span({ attributes: { a: 'x'.repeat(40), b: 2, c: 3 } }));
    expect(recorded[0]!.content.attributes).toEqual({ a: `${'x'.repeat(16)}…`, b: 2 });
  });

  it('drops spans `ignore` returns true for', () => {
    const processor = make({ ignore: (s) => s.name.startsWith('middleware') });
    run(processor, span({ name: 'middleware - cors' }), span({ name: 'handler' }));
    expect(names()).toEqual(['handler']);
  });

  it('never throws into the instrumented code', () => {
    const processor = make();
    telescopeRuntime().record = () => {
      throw new Error('store down');
    };
    expect(() => run(processor, span())).not.toThrow();
  });
});
