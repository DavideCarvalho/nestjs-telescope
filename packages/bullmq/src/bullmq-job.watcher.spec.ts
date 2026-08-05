// packages/bullmq/src/bullmq-job.watcher.spec.ts
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
import type { DiscoveryService } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { BullMqJobWatcher } from './bullmq-job.watcher.js';

// A realistic WorkerHost subclass. `process` is what the watcher must wrap.
// A loose stand-in for the BullMQ Job shape the test processor reads.
type JobStub = {
  id?: string;
  name?: string;
  queueName?: string;
  attemptsMade?: number;
  opts?: { attempts?: number };
  data?: { boom?: boolean; to?: string };
};

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
}

// The fake context simulates batch scoping: runInBatch assigns a batch id for
// the duration of its callback, and record() stamps each entry with the active
// batch — so a test can assert that work emitted inside process() shares the
// job's batch. `recordThrows` simulates a hostile/regressed Recorder.
function makeHarness(
  initialProviders: Array<{ instance: unknown }> = [],
  options: { recordThrows?: boolean } = {},
): Harness {
  const providers = [...initialProviders];
  const recorded: RecordedEntry[] = [];
  const origins: BatchOrigin[] = [];
  let batchSeq = 0;
  let currentBatch: string | null = null;
  const discovery = {
    getProviders: () => providers,
  } as unknown as DiscoveryService;

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
    moduleRef: { get: () => discovery } as unknown as WatcherContext['moduleRef'],
  };
  return { ctx, recorded, origins, providers };
}

describe('BullMqJobWatcher', () => {
  it('has type "job"', () => {
    expect(new BullMqJobWatcher().type).toBe('job');
  });

  it('wraps a WorkerHost process() and records a completed job correlated to a queue batch', async () => {
    const proc = new EmailProcessor();
    const { ctx, recorded, origins } = makeHarness([{ instance: proc }]);
    await new BullMqJobWatcher().register(ctx);

    const result = await proc.process({
      id: '1',
      name: 'send-welcome-email',
      queueName: 'mail',
      attemptsMade: 1,
      opts: { attempts: 3 },
      data: { to: 'ada@example.com' },
    });

    expect(result).toBe('ok'); // original behavior preserved
    expect(proc.calls).toBe(1); // original actually ran
    expect(origins).toEqual(['queue']); // ran inside a 'queue' batch
    expect(recorded).toHaveLength(1);
    const entry = recorded[0]!;
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

  it('records a failed job and re-throws so the host still sees the error', async () => {
    const proc = new EmailProcessor();
    const { ctx, recorded } = makeHarness([{ instance: proc }]);
    await new BullMqJobWatcher().register(ctx);

    await expect(
      proc.process({ id: '2', name: 'send', queueName: 'mail', data: { boom: true } }),
    ).rejects.toThrow('SMTP down');

    const jobEntry = recorded.find((e) => e.type === 'job');
    expect(jobEntry!.content).toMatchObject({ status: 'failed', failureReason: 'SMTP down' });
    expect(jobEntry!.tags).toContain('failed');
  });

  it('records an exception entry for a failed job, in the job’s own batch', async () => {
    const proc = new EmailProcessor();
    const { ctx, recorded } = makeHarness([{ instance: proc }]);
    await new BullMqJobWatcher().register(ctx);

    await expect(
      proc.process({
        id: '2',
        name: 'send',
        queueName: 'mail',
        attemptsMade: 2,
        data: { boom: true },
      }),
    ).rejects.toThrow('SMTP down');

    const jobEntry = recorded.find((e) => e.type === 'job');
    const exception = recorded.find((e) => e.type === 'exception');
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
  // family here it would page on-call through the back door the front door was
  // hardened against.
  it('applies the shared 4xx skip: a NotFoundException from a job records no exception', async () => {
    class NotFoundProcessor extends WorkerHost {
      async process(_job: JobStub): Promise<never> {
        throw new NotFoundException('no such user');
      }
    }
    const proc = new NotFoundProcessor();
    const { ctx, recorded } = makeHarness([{ instance: proc }]);
    await new BullMqJobWatcher().register(ctx);

    await expect(proc.process({ id: '7', name: 'lookup', queueName: 'users' })).rejects.toThrow(
      'no such user',
    );

    expect(recorded.filter((e) => e.type === 'exception')).toHaveLength(0);
    // The failed job entry is still recorded — the 4xx is not lost, it just
    // doesn't spawn an exception family.
    expect(recorded.filter((e) => e.type === 'job')).toHaveLength(1);
  });

  it('records no exception entry for a job that succeeds', async () => {
    const proc = new EmailProcessor();
    const { ctx, recorded } = makeHarness([{ instance: proc }]);
    await new BullMqJobWatcher().register(ctx);

    await proc.process({ id: '8', name: 'send', queueName: 'mail' });

    expect(recorded.filter((e) => e.type === 'exception')).toHaveLength(0);
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
    const { ctx, recorded } = makeHarness([{ instance: proc }]);
    await new BullMqJobWatcher({ slowMs: 100, clock }).register(ctx);

    await proc.process({ id: '3', name: 'slow', queueName: 'reports' });

    expect(recorded[0]!.durationMs).toBe(150);
    expect(recorded[0]!.tags).toContain('slow');
  });

  it('ignores non-WorkerHost providers and null instances', async () => {
    const proc = new EmailProcessor();
    const { ctx, recorded } = makeHarness([
      { instance: null },
      { instance: new NotAProcessor() },
      { instance: proc },
    ]);
    await new BullMqJobWatcher().register(ctx);

    await new NotAProcessor().process(); // must NOT be wrapped
    expect(recorded).toHaveLength(0);

    await proc.process({ id: '4', name: 'x', queueName: 'q' });
    expect(recorded).toHaveLength(1);
  });

  it('patches a shared prototype only once even with multiple instances', async () => {
    const a = new EmailProcessor();
    const b = new EmailProcessor();
    const { ctx, recorded } = makeHarness([{ instance: a }, { instance: b }]);
    await new BullMqJobWatcher().register(ctx);

    await a.process({ id: '5', name: 'x', queueName: 'q' });
    expect(recorded).toHaveLength(1); // not double-wrapped
  });

  it('registers cleanly when no processors are present', async () => {
    const { ctx, recorded } = makeHarness([{ instance: new NotAProcessor() }]);
    await expect(new BullMqJobWatcher().register(ctx)).resolves.toBeUndefined();
    expect(recorded).toHaveLength(0);
  });

  it('correlates work emitted during process to the same queue batch as the job entry', async () => {
    const { ctx, recorded, providers } = makeHarness();
    // Fresh subclass -> pristine prototype, isolated from other tests.
    class CorrelatingProcessor extends WorkerHost {
      async process(_job: JobStub): Promise<string> {
        // Simulate a query/exception emitted while the job runs.
        ctx.record({ type: 'query', content: { sql: 'select 1' } });
        return 'ok';
      }
    }
    const proc = new CorrelatingProcessor();
    providers.push({ instance: proc });
    await new BullMqJobWatcher().register(ctx);

    await proc.process({ id: '9', name: 'corr', queueName: 'q' });

    const innerQuery = recorded.find((e) => e.type === 'query');
    const jobEntry = recorded.find((e) => e.type === 'job');
    expect(innerQuery).toBeDefined();
    expect(jobEntry).toBeDefined();
    expect(jobEntry!.batch).not.toBeNull();
    // Inner work and the job entry share the one 'queue' batch.
    expect(innerQuery!.batch).toBe(jobEntry!.batch);
  });

  it('never corrupts the job outcome when ctx.record throws', async () => {
    // Fresh subclasses -> pristine prototypes (no wrapper nesting from prior tests).
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
    await new BullMqJobWatcher().register(okHarness.ctx);
    // Success must stay success even though record() throws.
    await expect(okProc.process({ id: '1', name: 'x', queueName: 'q' })).resolves.toBe('ok');

    const boomProc = new BoomProc();
    const boomHarness = makeHarness([{ instance: boomProc }], { recordThrows: true });
    await new BullMqJobWatcher().register(boomHarness.ctx);
    // The host's original error must propagate, not the recorder's.
    await expect(boomProc.process({ id: '2', name: 'x', queueName: 'q' })).rejects.toThrow(
      'SMTP down',
    );
  });
});
