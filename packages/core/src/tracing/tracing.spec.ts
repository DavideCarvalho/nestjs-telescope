// Units of tracing across apps: the W3C header rules, `propagation` resolution, target matching,
// header injection (never twice, never on telescope's own work, never beside OpenTelemetry), and
// the trace id precedence of a recorded entry.
import { afterEach, describe, expect, it } from 'vitest';
import { TelescopeContext } from '../context/telescope-context.js';
import { runAsTelescopeWork } from '../otel/telescope-runtime.js';
import { Recorder } from '../recorder/recorder.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { isPropagationTarget, resolvePropagation } from './config.js';
import { injectIntoClientRequest, injectIntoUndiciRequest } from './outbound.js';
import {
  TELESCOPE_TRACING_KEY,
  type TelescopeTracingSlot,
  outgoingTraceHeaders,
  publishTracingSlot,
  setTracingRuntime,
  traceScopeForRequest,
} from './runtime.js';
import { newTraceScope, runInTraceScope } from './scope.js';
import { formatTraceparent, parseTraceparent, parseTracestate } from './traceparent.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';
const PARENT = `00-${TRACE}-${SPAN}-01`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A stand-in for undici's `Request` as `undici:request:create` hands it over. */
function undiciRequest(origin: string, headers: string[] = []) {
  return {
    origin,
    headers: [...headers],
    addHeader(name: string, value: string) {
      this.headers.push(name, value);
    },
  };
}

function headerValues(headers: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < headers.length; i += 2) {
    if (headers[i]?.toLowerCase() === name) out.push(headers[i + 1] as string);
  }
  return out;
}

describe('traceparent', () => {
  it('parses a valid header and rejects what the spec says to ignore', () => {
    expect(parseTraceparent(PARENT)).toEqual({ traceId: TRACE, spanId: SPAN, flags: '01' });
    expect(parseTraceparent([PARENT.toUpperCase()])?.traceId).toBe(TRACE);
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01-extra`)?.traceId).toBe(TRACE);
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01-extra`)).toBeUndefined();
    expect(parseTraceparent(`ff-${TRACE}-${SPAN}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE}-${'0'.repeat(16)}-01`)).toBeUndefined();
    expect(parseTraceparent('garbage')).toBeUndefined();
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(formatTraceparent(TRACE, SPAN)).toBe(PARENT);
  });

  it('forwards only a printable, bounded tracestate', () => {
    expect(parseTracestate('vendor=a,other=b')).toBe('vendor=a,other=b');
    expect(parseTracestate('a=b\r\nx: y')).toBeUndefined();
    expect(parseTracestate('x'.repeat(513))).toBeUndefined();
    expect(parseTracestate('')).toBeUndefined();
  });
});

describe('propagation config', () => {
  it('is off for a standalone app that configures nothing', () => {
    expect(resolvePropagation(undefined, false)).toEqual({
      targets: [],
      incoming: false,
      nodeHttp: false,
      queue: false,
      startTraces: false,
    });
  });

  it('continues incoming traces by default on a tenant or a control plane', () => {
    const config = resolvePropagation(undefined, true);
    expect(config.incoming).toBe(true);
    expect(config.startTraces).toBe(false);
    expect(config.targets).toEqual([]);
  });

  it('reads targets as origins and refuses what is not one', () => {
    const config = resolvePropagation(
      { targets: ['https://Billing.internal/api/v1', /\.svc$/] },
      false,
    );
    expect(config.targets[0]).toBe('https://billing.internal');
    expect(config.startTraces).toBe(true);
    expect(isPropagationTarget(config.targets, 'https://billing.internal')).toBe(true);
    expect(isPropagationTarget(config.targets, 'http://search.svc')).toBe(true);
    expect(isPropagationTarget(config.targets, 'https://api.stripe.com')).toBe(false);
    expect(isPropagationTarget('all', 'https://api.stripe.com')).toBe(true);
    expect(() => resolvePropagation({ targets: ['billing'] }, false)).toThrow(/not an http\(s\)/);
  });
});

describe('outgoing headers', () => {
  const config = resolvePropagation({ targets: ['http://billing.internal'] }, false);

  it('adds traceparent and the caller tracestate inside a continued trace', () => {
    const parent = parseTraceparent(PARENT);
    const scope = newTraceScope(parent, 'vendor=a');
    const request = undiciRequest('http://billing.internal');
    runInTraceScope(scope, () => injectIntoUndiciRequest(config, request));
    expect(headerValues(request.headers, 'traceparent')).toEqual([
      `00-${TRACE}-${scope.spanId}-01`,
    ]);
    expect(headerValues(request.headers, 'tracestate')).toEqual(['vendor=a']);
  });

  it('never injects twice, never to a non-target, never outside a trace', () => {
    const scope = newTraceScope();
    const own = undiciRequest('http://billing.internal', ['Traceparent', PARENT]);
    const stripe = undiciRequest('https://api.stripe.com');
    const outside = undiciRequest('http://billing.internal');
    runInTraceScope(scope, () => {
      injectIntoUndiciRequest(config, own);
      injectIntoUndiciRequest(config, own);
      injectIntoUndiciRequest(config, stripe);
    });
    injectIntoUndiciRequest(config, outside);
    expect(headerValues(own.headers, 'traceparent')).toEqual([PARENT]);
    expect(stripe.headers).toEqual([]);
    expect(outside.headers).toEqual([]);
  });

  it("adds nothing to telescope's own calls", () => {
    const request = undiciRequest('http://billing.internal');
    runInTraceScope(newTraceScope(), () =>
      runAsTelescopeWork(() => injectIntoUndiciRequest(config, request)),
    );
    expect(request.headers).toEqual([]);
  });

  /** Stand in for `@opentelemetry/api`'s global (`Symbol.for('opentelemetry.js.api.1')`). */
  function otelGlobal(value: unknown): void {
    const key = Symbol.for('opentelemetry.js.api.1');
    const slot = globalThis as Record<symbol, unknown>;
    const previous = slot[key];
    slot[key] = value;
    cleanups.push(() => {
      slot[key] = previous;
    });
  }

  function injected(): string[] {
    const request = undiciRequest('http://billing.internal');
    runInTraceScope(newTraceScope(), () => injectIntoUndiciRequest(config, request));
    return headerValues(request.headers, 'traceparent');
  }

  it('adds nothing while an OpenTelemetry propagator writing traceparent is registered', () => {
    // What `provider.register()` leaves: the W3C propagator, which lists its fields.
    otelGlobal({
      version: '1.9.0',
      trace: {},
      context: {},
      propagation: { fields: () => ['traceparent', 'tracestate', 'baggage'] },
    });
    expect(injected()).toEqual([]);
  });

  it('still adds the header when OpenTelemetry registered no such propagator', () => {
    // Only a meter provider (the API global exists, `propagation` does not).
    otelGlobal({ version: '1.9.0', metrics: {} });
    expect(injected()).toHaveLength(1);
    // A propagator that never writes traceparent (B3 only, or the no-op one).
    otelGlobal({ version: '1.9.0', propagation: { fields: () => ['x-b3-traceid'] } });
    expect(injected()).toHaveLength(1);
    otelGlobal({ version: '1.9.0', propagation: { fields: () => [] } });
    expect(injected()).toHaveLength(1);
  });

  it('sets node:http headers unless the code set one', () => {
    const headers = new Map<string, string>();
    const clientRequest = {
      protocol: 'http:',
      host: 'billing.internal',
      getHeader: (name: string) => headers.get(name),
      setHeader: (name: string, value: string) => headers.set(name, value),
    };
    const scope = newTraceScope(parseTraceparent(PARENT));
    runInTraceScope(scope, () => injectIntoClientRequest(config, clientRequest));
    expect(headers.get('traceparent')).toBe(`00-${TRACE}-${scope.spanId}-01`);
    headers.set('traceparent', PARENT);
    runInTraceScope(newTraceScope(), () => injectIntoClientRequest(config, clientRequest));
    expect(headers.get('traceparent')).toBe(PARENT);
  });

  it('falls back to the nestjs-context trace id outside a scope', () => {
    cleanups.push(
      setTracingRuntime({
        incoming: true,
        startTraces: false,
        queue: true,
        contextTraceId: () => TRACE,
      }),
    );
    expect(outgoingTraceHeaders()?.traceparent).toMatch(
      new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`),
    );
  });
});

describe('incoming requests', () => {
  it('continues a caller, starts a trace only when configured', () => {
    const continued = traceScopeForRequest(
      { traceparent: PARENT, tracestate: 'v=1' },
      { incoming: true, startTraces: false },
    );
    expect(continued).toMatchObject({
      upstreamTraceId: TRACE,
      parentSpanId: SPAN,
      tracestate: 'v=1',
    });
    expect(traceScopeForRequest({}, { incoming: true, startTraces: false })).toBeUndefined();
    expect(traceScopeForRequest({}, { incoming: true, startTraces: true })?.upstreamTraceId).toBe(
      null,
    );
    // `incoming: false`: the caller's trace is not taken.
    const own = traceScopeForRequest(
      { traceparent: PARENT },
      { incoming: false, startTraces: true },
    );
    expect(own?.upstreamTraceId).toBeNull();
    expect(own?.fallbackTraceId).not.toBe(TRACE);
  });
});

describe('the BullMQ slot', () => {
  it('continues a job carrier and stays out of telescope work', () => {
    cleanups.push(
      setTracingRuntime({
        incoming: true,
        startTraces: true,
        queue: true,
        contextTraceId: () => undefined,
      }),
      publishTracingSlot(),
    );
    const slot = (globalThis as Record<symbol, unknown>)[
      TELESCOPE_TRACING_KEY
    ] as TelescopeTracingSlot;
    const links = slot.continueFrom({ traceparent: PARENT }, () => slot.spanLinks());
    expect(links?.parentSpanId).toBe(SPAN);
    expect(slot.continueFrom({ traceparent: PARENT }, () => slot.outgoing()?.traceparent)).toMatch(
      new RegExp(`^00-${TRACE}-`),
    );
    expect(
      slot.continueFrom({ traceparent: PARENT }, () => runAsTelescopeWork(() => slot.outgoing())),
    ).toBeNull();
    expect(slot.continueFrom(undefined, () => slot.spanLinks())).toBeNull();
  });
});

describe('recorded entries', () => {
  function recorder(contextTraceId?: string) {
    const storage = new InMemoryStorageProvider();
    let n = 0;
    const rec = new Recorder({
      storage,
      context: new TelescopeContext(),
      idFactory: () => `id-${n++}`,
      instanceId: 'i',
      taggers: [],
      redact: {},
      sampling: {},
      bufferSize: 100,
      delay: () => Promise.resolve(),
      ...(contextTraceId !== undefined
        ? {
            contextAccessor: {
              traceId: () => contextTraceId,
              tenantId: () => undefined,
              userRef: () => undefined,
              get: () => undefined,
            },
          }
        : {}),
    });
    return { rec, storage };
  }

  it('carry the caller trace before the context one, and the started one after it', async () => {
    const ctx = 'c'.repeat(32);
    const { rec, storage } = recorder(ctx);
    const continued = newTraceScope(parseTraceparent(PARENT));
    runInTraceScope(continued, () => rec.record({ type: 'log', content: {} }));
    const started = newTraceScope();
    runInTraceScope(started, () => rec.record({ type: 'log', content: {} }));
    rec.record({ type: 'log', content: {} });
    await rec.flush();
    const all = (await storage.get({ limit: 10 })).data;
    expect(all.map((e) => e.traceId).sort()).toEqual([TRACE, ctx, ctx].sort());
    expect(all.find((e) => e.traceId === TRACE)?.spanId).toBe(continued.spanId);
  });

  it('are unchanged outside any scope', async () => {
    const { rec, storage } = recorder();
    rec.record({ type: 'log', content: {} });
    await rec.flush();
    const [entry] = (await storage.get({ limit: 1 })).data;
    expect(entry?.traceId).toBeNull();
    expect(entry?.spanId).toBeNull();
  });
});
