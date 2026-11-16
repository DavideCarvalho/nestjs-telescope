// packages/bullmq/src/trace-propagation.ts
//
// Tracing across apps through BullMQ jobs. On `Queue.add` / `addBulk`, the current trace is written
// into the job's own trace carrier (`opts.telemetry.metadata`, the field BullMQ's OpenTelemetry
// integration uses, as the same JSON `{ traceparent, tracestate }`); the worker runs the job in that
// trace, in whichever app it lives. Telescope core publishes what this needs on a global slot, so
// this package works with any core version: without the slot (an older core, no `propagation`)
// every job is added and run exactly as before.
import { createRequire } from 'node:module';

/** Mirror of core's `TelescopeTracingSlot` (`@dudousxd/nestjs-telescope:tracing`). */
interface TracingSlot {
  readonly queue: boolean;
  outgoing(): { traceparent: string; tracestate?: string } | null;
  continueFrom<T>(
    carrier: { traceparent?: unknown; tracestate?: unknown } | undefined,
    fn: () => T,
  ): T;
  spanLinks(): { spanId: string; parentSpanId: string | null } | null;
}

const TRACING_KEY = Symbol.for('@dudousxd/nestjs-telescope:tracing');
const PATCHED = Symbol.for('@dudousxd/nestjs-telescope:bullmq-queue-propagation');

function tracingSlot(): TracingSlot | undefined {
  const slot = (globalThis as Record<symbol, unknown>)[TRACING_KEY] as TracingSlot | undefined;
  return slot !== undefined && typeof slot.outgoing === 'function' ? slot : undefined;
}

interface TelemetryOpts {
  metadata?: unknown;
  omitContext?: unknown;
}
interface JobOptsLike {
  telemetry?: TelemetryOpts;
  [key: string]: unknown;
}

/** The trace carrier a job holds (`opts.telemetry.metadata`), or `undefined`. */
export function jobTraceCarrier(
  job: unknown,
): { traceparent?: unknown; tracestate?: unknown } | undefined {
  const metadata = (job as { opts?: JobOptsLike } | null)?.opts?.telemetry?.metadata;
  if (typeof metadata !== 'string' || metadata === '' || metadata.length > 2048) return undefined;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as { traceparent?: unknown; tracestate?: unknown })
      : undefined;
  } catch {
    return undefined;
  }
}

/** Run `fn` (a job) in the trace its dispatcher wrote into it; as is when it carries none. */
export function runInJobTrace<T>(job: unknown, fn: () => T): T {
  const slot = tracingSlot();
  if (slot === undefined || !slot.queue) return fn();
  const carrier = jobTraceCarrier(job);
  if (carrier === undefined) return fn();
  return slot.continueFrom(carrier, fn);
}

/** The span that dispatched the running job, when it runs in a propagated trace. */
export function jobParentSpanId(job: unknown): string | null {
  const slot = tracingSlot();
  if (slot === undefined || !slot.queue || jobTraceCarrier(job) === undefined) return null;
  try {
    return slot.spanLinks()?.parentSpanId ?? null;
  } catch {
    return null;
  }
}

/**
 * `opts` with the current trace in `telemetry.metadata`, or `opts` unchanged: outside a trace,
 * inside telescope's own work, when the queue has BullMQ telemetry (OpenTelemetry writes it then),
 * or when the job already carries one.
 */
export function withJobTrace(queue: unknown, opts: unknown): unknown {
  try {
    const slot = tracingSlot();
    if (slot === undefined || !slot.queue) return opts;
    if ((queue as { opts?: { telemetry?: unknown } } | null)?.opts?.telemetry !== undefined) {
      return opts;
    }
    const current = (typeof opts === 'object' && opts !== null ? opts : {}) as JobOptsLike;
    if (current.telemetry?.metadata !== undefined || current.telemetry?.omitContext === true) {
      return opts;
    }
    const headers = slot.outgoing();
    if (headers === null) return opts;
    return {
      ...current,
      telemetry: { ...current.telemetry, metadata: JSON.stringify(headers) },
    };
  } catch {
    // Propagation never breaks a dispatch.
    return opts;
  }
}

interface QueuePrototype {
  add?: (...args: unknown[]) => unknown;
  addBulk?: (...args: unknown[]) => unknown;
  [PATCHED]?: true;
}

/** Patch one `Queue` class (exported for tests). */
export function patchQueue(QueueClass: unknown): void {
  const proto = (QueueClass as { prototype?: QueuePrototype } | null)?.prototype;
  if (proto === undefined || proto[PATCHED] === true) return;
  const add = proto.add;
  const addBulk = proto.addBulk;
  if (typeof add !== 'function') return;
  proto.add = function (this: unknown, name: unknown, data: unknown, opts?: unknown) {
    return add.call(this, name, data, withJobTrace(this, opts));
  };
  if (typeof addBulk === 'function') {
    proto.addBulk = function (this: unknown, jobs: unknown) {
      const traced = Array.isArray(jobs)
        ? jobs.map((job) =>
            typeof job === 'object' && job !== null
              ? { ...job, opts: withJobTrace(this, (job as { opts?: unknown }).opts) }
              : job,
          )
        : jobs;
      return addBulk.call(this, traced);
    };
  }
  Object.defineProperty(proto, PATCHED, { value: true, configurable: true });
}

/**
 * Patch `Queue.add` / `addBulk` of every copy of bullmq the app can load: the CommonJS one
 * `@nestjs/bullmq` requires, and this package's own CommonJS and ESM ones. Idempotent. Inert while
 * no telescope publishes the tracing slot.
 */
export async function installQueuePropagation(): Promise<void> {
  const require = createRequire(import.meta.url);
  const sources: Array<() => unknown> = [
    () => createRequire(require.resolve('@nestjs/bullmq'))('bullmq'),
    () => require('bullmq'),
  ];
  for (const load of sources) {
    try {
      patchQueue((load() as { Queue?: unknown }).Queue);
    } catch {
      // That copy is not installed.
    }
  }
  try {
    const specifier = 'bullmq';
    patchQueue(((await import(specifier)) as { Queue?: unknown }).Queue);
  } catch {
    // No ESM copy.
  }
}
