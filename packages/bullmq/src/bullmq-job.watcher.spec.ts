// packages/bullmq/src/bullmq-job.watcher.spec.ts
//
// Unit-level tests drive the SEAM, not `processor.process()`: they build the
// function `BullExplorer` would hand `new Worker(...)` — `decorate(bound
// process)` — and call that. Invoking `process()` directly is exactly the
// shortcut that let a completely dead instrumentation strategy keep a green
// suite while a real Redis produced zero entries per job.
//
// The decoration always happens BEFORE `register()` here, mirroring the real
// lifecycle: the explorer decorates at `BullRegistrar.onModuleInit`, Telescope
// binds its context at `onApplicationBootstrap`.
//
import 'reflect-metadata';
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  captureException,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { WorkerHost } from '@nestjs/bullmq';
import { NotFoundException } from '@nestjs/common';
import { DiscoveryService, type ModuleRef } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { BullMqJobWatcher } from './bullmq-job.watcher.js';
import {
  installProcessorInstrumentation,
  isInstrumentedProcessor,
} from './processor-instrumentation.js';

/** A loose stand-in for the BullMQ Job shape the test processors read. */
type JobStub = {
  id?: string;
  name?: string;
  queueName?: string;
  attemptsMade?: number;
  opts?: { attempts?: number };
  data?: { boom?: boolean; to?: string };
};

// A realistic WorkerHost subclass. Its bound `process` is what the explorer
// decorates, and the decorated function is what the worker calls per job.
class EmailProcessor extends WorkerHost {
  public calls = 0;
  async process(job: JobStub): Promise<string> {
    this.calls++;
    if (job?.data?.boom) throw new Error('SMTP down');
    return 'ok';
  }
}

class NotAProcessor {
  async process(): Promise<void> {}
}

interface RecordedEntry extends RecordInput {
  batch: string | null;
}

interface Harness {
  ctx: WatcherContext;
  recorded: RecordedEntry[];
  origins: BatchOrigin[];
  providers: Array<{ instance: unknown }>;
  /** The function BullExplorer would give the worker for this processor. */
  processorFor(instance: {
    process: (job: JobStub, token?: string) => Promise<unknown>;
  }): (job: JobStub, token?: string) => Promise<unknown>;
}

/** Structural stand-in for ModuleRef — the watcher only ever calls `get`. */
function asModuleRef(source: { get(token: unknown): unknown }): ModuleRef {
  const candidate: unknown = source;
  if (isModuleRef(candidate)) return candidate;
  throw new Error('unreachable: the stand-in exposes get()');
}

function isModuleRef(value: unknown): value is ModuleRef {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'get') === 'function';
}

/** Call the decorated processor without pretending to know BullMQ's Job type. */
function callProcessor(fn: unknown, job: JobStub, token?: string): Promise<unknown> {
  if (typeof fn !== 'function') throw new Error('expected a processor function');
  return Promise.resolve(fn(job, token));
}

/** The seam forwards `unknown[]`; narrow it back to what a processor is given. */
function toJobArgs(args: unknown[]): [JobStub, string | undefined] {
  const [job, token] = args;
  return [
    typeof job === 'object' && job !== null ? job : {},
    typeof token === 'string' ? token : undefined,
  ];
}

// The fake context simulates batch scoping: runInBatch assigns a batch id for
// the duration of its callback, and record() stamps each entry with the active
// batch — so a test can assert that work emitted inside process() shares the
// job's batch. `recordThrows` simulates a hostile/regressed Recorder.
function makeHarness(
  initialProviders: Array<{ instance: unknown }> = [],
  options: { recordThrows?: boolean; seamUnavailable?: boolean } = {},
): Harness {
  const providers = [...initialProviders];
  const recorded: RecordedEntry[] = [];
  const origins: BatchOrigin[] = [];
  let batchSeq = 0;
  let currentBatch: string | null = null;
  const discovery = { getProviders: () => providers };

  // Stands in for the app's ProcessorDecoratorService instance: the watcher
  // recognises it by the patched `decorate`, and per-app state hangs off it.
  const { decorate } = installProcessorInstrumentation();
  const decoratorService = { decorate };
  // A host that replaced ProcessorDecoratorService with its own subclass: the
  // patch is shadowed, so the watcher must notice and take the fallback.
  const resolvedDecorator = options.seamUnavailable
    ? { decorate: (processor: unknown) => processor }
    : decoratorService;

  const ctx: WatcherContext = {
    record: (input) => {
      if (options.recordThrows) throw new Error('recorder boom');
      recorded.push({ ...input, batch: currentBatch });
    },
    // The REAL capture (family hash + 4xx policy), so these tests assert on the
    // entry production would store, not on a stand-in of it.
    recordException: (error, details) => {
      if (options.recordThrows) throw new Error('recorder boom');
      captureException(
        (input) => recorded.push({ ...input, batch: currentBatch }),
        error,
        undefined,
        details,
      );
    },
    runInBatch: async <T>(origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => {
      origins.push(origin);
      const previous = currentBatch;
      currentBatch = `batch-${batchSeq++}`;
      try {
        return await fn();
      } finally {
        currentBatch = previous;
      }
    },
    beginBatch: (): BatchHandle => ({ id: 'batch', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: asModuleRef({
      get: (token: unknown) => (token === DiscoveryService ? discovery : resolvedDecorator),
    }),
  };

  return {
    ctx,
    recorded,
    origins,
    providers,
    processorFor: (instance) => {
      // Exactly BullExplorer.handleProcessor's static branch.
      const bound = (...args: unknown[]): unknown => {
        const [job, token] = toJobArgs(args);
        return instance.process(job, token);
      };
      const decorated: unknown = decoratorService.decorate?.(bound);
      return (job, token) => callProcessor(decorated, job, token);
    },
  };
}

describe('BullMqJobWatcher', () => {
  it('has type "job"', () => {
    expect(new BullMqJobWatcher().type).toBe('job');
  });

  it('wraps the decorated processor and records a completed job in a queue batch', async () => {
    const proc = new EmailProcessor();
    const harness = makeHarness([{ instance: proc }]);
    const run = harness.processorFor(proc);
    await new BullMqJobWatcher().register(harness.ctx);

    const result = await run({
      id: '1',
      name: 'send-welcome-email',
      queueName: 'mail',
      attemptsMade: 1,
      opts: { attempts: 3 },
      data: { to: 'ada@example.com' },
    });

    expect(result).toBe('ok'); // original behavior preserved
    expect(proc.calls).toBe(1); // original actually ran
    expect(harness.origins).toEqual(['queue']); // ran inside a 'queue' batch
    expect(harness.recorded).toHaveLength(1);
    const entry = harness.recorded[0]!;
    expect(entry.type).toBe('job');
    expect(entry.content).toMatchObject({
      id: '1',
      name: 'send-welcome-email',
      queue: 'mail',
      status: 'completed',
    });
    expect(entry.tags).toContain('queue:mail');
    expect(entry.tags).toContain('job:send-welcome-email');
    expect(entry.familyHash).toBe('mail:send-welcome-email');
  });

  it('reports the processors decorated before register() — the ordering proof', async () => {
    const proc = new EmailProcessor();
    const harness = makeHarness([{ instance: proc }]);
    // The explorer decorates at ITS onModuleInit, i.e. before Telescope registers.
    harness.processorFor(proc);
    const watcher = new BullMqJobWatcher();
    await watcher.register(harness.ctx);

    expect(watcher.instrumentedBeforeRegister).toBe(1);
  });

  it('records a failed job and re-throws so the host still sees the error', async () => {
    const proc = new EmailProcessor();
    const harness = makeHarness([{ instance: proc }]);
    const run = harness.processorFor(proc);
    await new BullMqJobWatcher().register(harness.ctx);

    await expect(
      run({ id: '2', name: 'send', queueName: 'mail', data: { boom: true } }),
    ).rejects.toThrow('SMTP down');

    const jobEntry = harness.recorded.find((e) => e.type === 'job');
    expect(jobEntry!.content).toMatchObject({ status: 'failed', failureReason: 'SMTP down' });
    expect(jobEntry!.tags).toContain('failed');
  });

  it('records an exception entry for a failed job, in the job’s own batch', async () => {
    const proc = new EmailProcessor();
    const harness = makeHarness([{ instance: proc }]);
    const run = harness.processorFor(proc);
    await new BullMqJobWatcher().register(harness.ctx);

    await expect(
      run({
        id: '2',
        name: 'send',
        queueName: 'mail',
        attemptsMade: 2,
        data: { boom: true },
      }),
    ).rejects.toThrow('SMTP down');

    const jobEntry = harness.recorded.find((e) => e.type === 'job');
    const exception = harness.recorded.find((e) => e.type === 'exception');
    expect(exception).toBeDefined();
    // The failed job entry alone carries the message as a string only — it opens
    // no family, so nothing alerts or diagnoses on it. The exception entry is
    // what makes the failure visible to the rest of Telescope.
    expect(exception!.familyHash).toMatch(/^Error:SMTP down:at /);
    expect(exception!.content).toMatchObject({ class: 'Error', message: 'SMTP down' });
    // Off the request path nothing else names the unit of work, so the entry does.
    expect((exception!.content as { context: Record<string, unknown> }).context).toEqual({
      queue: 'mail',
      job: 'send',
      jobId: '2',
      attempts: 2,
    });
    expect(exception!.tags).toEqual(['queue:mail', 'job:send']);
    // One failure, one batch — not a job entry here and an orphan exception there.
    expect(exception!.batch).toBe(jobEntry!.batch);
    expect(exception!.batch).not.toBeNull();
  });

  // A worker that re-uses a service throwing NotFoundException is expected
  // control flow, exactly as it is on a route. If a retrying queue could open a
  // family here it would page on-call through the back door that the front door
  // was hardened against.
  it('applies the shared 4xx skip: a NotFoundException from a job records no exception', async () => {
    class NotFoundProcessor extends WorkerHost {
      async process(_job: JobStub): Promise<never> {
        throw new NotFoundException('no such user');
      }
    }
    const proc = new NotFoundProcessor();
    const harness = makeHarness([{ instance: proc }]);
    const run = harness.processorFor(proc);
    await new BullMqJobWatcher().register(harness.ctx);

    await expect(run({ id: '7', name: 'lookup', queueName: 'users' })).rejects.toThrow(
      'no such user',
    );

    expect(harness.recorded.filter((e) => e.type === 'exception')).toHaveLength(0);
    // The failed job entry is still recorded — the 4xx is not lost, it just
    // doesn't spawn an exception family.
    expect(harness.recorded.filter((e) => e.type === 'job')).toHaveLength(1);
  });

  it('records no exception entry for a job that succeeds', async () => {
    const proc = new EmailProcessor();
    const harness = makeHarness([{ instance: proc }]);
    const run = harness.processorFor(proc);
    await new BullMqJobWatcher().register(harness.ctx);

    await run({ id: '8', name: 'send', queueName: 'mail' });

    expect(harness.recorded.filter((e) => e.type === 'exception')).toHaveLength(0);
  });

  it('tags slow jobs whose duration meets slowMs', async () => {
    const proc = new EmailProcessor();
    // clock returns 0 then 150 on successive now() calls -> duration 150ms.
    let t = 0;
    const clock = {
      now: () => {
        const value = t;
        t += 150;
        return value;
      },
    };
    const harness = makeHarness([{ instance: proc }]);
    const run = harness.processorFor(proc);
    await new BullMqJobWatcher({ slowMs: 100, clock }).register(harness.ctx);

    await run({ id: '3', name: 'slow', queueName: 'reports' });

    expect(harness.recorded[0]!.durationMs).toBe(150);
    expect(harness.recorded[0]!.tags).toContain('slow');
  });

  it('forwards the token BullMQ passes alongside the job', async () => {
    const seen: Array<string | undefined> = [];
    class TokenProcessor extends WorkerHost {
      async process(_job: JobStub, token?: string): Promise<string> {
        seen.push(token);
        return 'ok';
      }
    }
    const proc = new TokenProcessor();
    const harness = makeHarness([{ instance: proc }]);
    const run = harness.processorFor(proc);
    await new BullMqJobWatcher().register(harness.ctx);

    await run({ id: '9', name: 'tok', queueName: 'q' }, 'token-123');

    expect(seen).toEqual(['token-123']);
  });

  // The fallback exists so an older @nestjs/bullmq (or a host that replaced the
  // decorator provider) still gets captured jobs instead of silence. It
  // re-points `worker.processFn`, the function BullMQ reads on every job.
  it('falls back to instrumenting worker.processFn when the seam is shadowed', async () => {
    class FallbackProcessor extends WorkerHost {
      public calls = 0;
      async process(_job: JobStub): Promise<string> {
        this.calls++;
        return 'ok';
      }
    }
    const proc = new FallbackProcessor();
    // What @nestjs/bullmq's explorer leaves behind on the host: the worker it
    // created, holding the bound (un-instrumented) processor.
    Reflect.set(proc, '_worker', { processFn: proc.process.bind(proc) });
    const harness = makeHarness([{ instance: proc }], { seamUnavailable: true });

    await new BullMqJobWatcher().register(harness.ctx);

    const worker: unknown = Reflect.get(proc, '_worker');
    const processFn =
      typeof worker === 'object' && worker !== null && Reflect.get(worker, 'processFn');
    expect(isInstrumentedProcessor(processFn)).toBe(true);

    await expect(callProcessor(processFn, { id: '5', name: 'fb', queueName: 'q' })).resolves.toBe(
      'ok',
    );
    expect(proc.calls).toBe(1);
    const jobEntry = harness.recorded.find((e) => e.type === 'job');
    expect(jobEntry?.content).toMatchObject({ name: 'fb', queue: 'q', status: 'completed' });
  });

  it('warns but does not throw when no processors are present', async () => {
    const harness = makeHarness([{ instance: new NotAProcessor() }]);
    await expect(new BullMqJobWatcher().register(harness.ctx)).resolves.toBeUndefined();
    expect(harness.recorded).toHaveLength(0);
  });

  it('correlates work emitted during process to the same queue batch as the job entry', async () => {
    const harness = makeHarness();
    class CorrelatingProcessor extends WorkerHost {
      async process(_job: JobStub): Promise<string> {
        // Simulate a query/exception emitted while the job runs.
        harness.ctx.record({ type: 'query', content: { sql: 'select 1' } });
        return 'ok';
      }
    }
    const proc = new CorrelatingProcessor();
    harness.providers.push({ instance: proc });
    const run = harness.processorFor(proc);
    await new BullMqJobWatcher().register(harness.ctx);

    await run({ id: '9', name: 'corr', queueName: 'q' });

    const innerQuery = harness.recorded.find((e) => e.type === 'query');
    const jobEntry = harness.recorded.find((e) => e.type === 'job');
    expect(innerQuery).toBeDefined();
    expect(jobEntry).toBeDefined();
    expect(jobEntry!.batch).not.toBeNull();
    // Inner work and the job entry share the one 'queue' batch.
    expect(innerQuery!.batch).toBe(jobEntry!.batch);
  });

  it('runs the job untraced when it fires before register() bound a context', async () => {
    const proc = new EmailProcessor();
    const harness = makeHarness([{ instance: proc }]);
    const run = harness.processorFor(proc);

    // A job picked up between onModuleInit and onApplicationBootstrap: not
    // captured, but it must still run and still return normally.
    await expect(run({ id: '10', name: 'early', queueName: 'q' })).resolves.toBe('ok');
    expect(proc.calls).toBe(1);
    expect(harness.recorded).toHaveLength(0);
  });

  it('never corrupts the job outcome when ctx.record throws', async () => {
    class OkProc extends WorkerHost {
      async process(_job: JobStub): Promise<string> {
        return 'ok';
      }
    }
    class BoomProc extends WorkerHost {
      async process(_job: JobStub): Promise<never> {
        throw new Error('SMTP down');
      }
    }

    const okProc = new OkProc();
    const okHarness = makeHarness([{ instance: okProc }], { recordThrows: true });
    const runOk = okHarness.processorFor(okProc);
    await new BullMqJobWatcher().register(okHarness.ctx);
    // Success must stay success even though record() throws.
    await expect(runOk({ id: '1', name: 'x', queueName: 'q' })).resolves.toBe('ok');

    const boomProc = new BoomProc();
    const boomHarness = makeHarness([{ instance: boomProc }], { recordThrows: true });
    const runBoom = boomHarness.processorFor(boomProc);
    await new BullMqJobWatcher().register(boomHarness.ctx);
    // The host's original error must propagate, not the recorder's.
    await expect(runBoom({ id: '2', name: 'x', queueName: 'q' })).rejects.toThrow('SMTP down');
  });
});
