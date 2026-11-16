// packages/bullmq/src/trace-propagation.spec.ts
import {
  currentTraceScope,
  isTelescopeWork,
  newTraceScope,
  parseTraceparent,
  runAsTelescopeWork,
  runInTraceScope,
} from '@dudousxd/nestjs-telescope';
import { afterEach, describe, expect, it } from 'vitest';
import { jobParentSpanId, patchQueue, runInJobTrace, withJobTrace } from './trace-propagation.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = `00-${TRACE}-00f067aa0ba902b7-01`;
const KEY = Symbol.for('@dudousxd/nestjs-telescope:tracing');
const slot = globalThis as Record<symbol, unknown>;

/** Core's slot, as a `TelescopeModule` with `propagation` publishes it. */
function publish(queue = true): void {
  slot[KEY] = {
    queue,
    outgoing: () => {
      const scope = currentTraceScope();
      if (scope === undefined || isTelescopeWork()) return null;
      return { traceparent: `00-${scope.fallbackTraceId}-${scope.spanId}-01` };
    },
    continueFrom: (carrier: { traceparent?: unknown } | undefined, fn: () => unknown) => {
      const parent = parseTraceparent(carrier?.traceparent);
      return parent === undefined ? fn() : runInTraceScope(newTraceScope(parent), fn);
    },
    spanLinks: () => {
      const scope = currentTraceScope();
      return scope ? { spanId: scope.spanId, parentSpanId: scope.parentSpanId } : null;
    },
  };
}

afterEach(() => {
  slot[KEY] = undefined;
});

class FakeQueue {
  readonly added: Array<{ name: unknown; opts: unknown }> = [];
  constructor(readonly opts: Record<string, unknown> = {}) {}
  add(name: unknown, _data: unknown, opts?: unknown) {
    this.added.push({ name, opts });
    return Promise.resolve();
  }
  addBulk(jobs: Array<{ name: unknown; opts?: unknown }>) {
    for (const job of jobs) this.added.push({ name: job.name, opts: job.opts });
    return Promise.resolve();
  }
}
patchQueue(FakeQueue);
patchQueue(FakeQueue);

function metadataOf(opts: unknown): unknown {
  const raw = (opts as { telemetry?: { metadata?: string } } | undefined)?.telemetry?.metadata;
  return raw === undefined ? undefined : JSON.parse(raw);
}

describe('BullMQ trace propagation', () => {
  it('writes the dispatching trace into each job, once', async () => {
    publish();
    const queue = new FakeQueue();
    const scope = newTraceScope();
    await runInTraceScope(scope, async () => {
      await queue.add('one', {}, { attempts: 2 });
      await queue.addBulk([{ name: 'two' }, { name: 'three', opts: { delay: 5 } }]);
    });
    expect(queue.added).toHaveLength(3);
    for (const job of queue.added) {
      expect(metadataOf(job.opts)).toEqual({
        traceparent: `00-${scope.fallbackTraceId}-${scope.spanId}-01`,
      });
    }
    expect(queue.added[0]?.opts).toMatchObject({ attempts: 2 });
    expect(queue.added[2]?.opts).toMatchObject({ delay: 5 });
  });

  it('adds nothing outside a trace, in telescope work, with BullMQ telemetry, or over a carrier', async () => {
    publish();
    const queue = new FakeQueue();
    await queue.add('outside', {});
    await runInTraceScope(newTraceScope(), async () => {
      await runAsTelescopeWork(() => queue.add('own', {}));
      await queue.add('carried', {}, { telemetry: { metadata: '{"traceparent":"x"}' } });
      await new FakeQueue({ telemetry: {} }).add('otel', {});
    });
    expect(queue.added.map((job) => metadataOf(job.opts))).toEqual([
      undefined,
      undefined,
      { traceparent: 'x' },
    ]);
  });

  it('is inert without the slot or with `queue: false`', () => {
    expect(withJobTrace(new FakeQueue(), { a: 1 })).toEqual({ a: 1 });
    publish(false);
    const opts = runInTraceScope(newTraceScope(), () => withJobTrace(new FakeQueue(), undefined));
    expect(opts).toBeUndefined();
  });

  it("runs a job in its dispatcher's trace", () => {
    publish();
    const job = { opts: { telemetry: { metadata: JSON.stringify({ traceparent: PARENT }) } } };
    const seen = runInJobTrace(job, () => ({
      trace: currentTraceScope()?.upstreamTraceId,
      parent: jobParentSpanId(job),
    }));
    expect(seen).toEqual({ trace: TRACE, parent: '00f067aa0ba902b7' });
    expect(runInJobTrace({ opts: {} }, () => currentTraceScope())).toBeUndefined();
    expect(runInJobTrace({ opts: { telemetry: { metadata: '{bad' } } }, () => 1)).toBe(1);
  });
});
