// packages/bullmq/src/bullmq-job.watcher.spec.ts
import 'reflect-metadata';
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { WorkerHost } from '@nestjs/bullmq';
import type { DiscoveryService } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { BullMqJobWatcher } from './bullmq-job.watcher.js';

// A realistic WorkerHost subclass. `process` is what the watcher must wrap.
// A loose stand-in for the BullMQ Job shape the test processor reads.
type JobStub = { id?: number; name?: string; queueName?: string; data?: { boom?: boolean } };

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
      id: 1,
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
      proc.process({ id: 2, name: 'send', queueName: 'mail', data: { boom: true } }),
    ).rejects.toThrow('SMTP down');

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.content).toMatchObject({ status: 'failed', failureReason: 'SMTP down' });
    expect(recorded[0]!.tags).toContain('failed');
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

    await proc.process({ id: 3, name: 'slow', queueName: 'reports' });

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

    await proc.process({ id: 4, name: 'x', queueName: 'q' });
    expect(recorded).toHaveLength(1);
  });

  it('patches a shared prototype only once even with multiple instances', async () => {
    const a = new EmailProcessor();
    const b = new EmailProcessor();
    const { ctx, recorded } = makeHarness([{ instance: a }, { instance: b }]);
    await new BullMqJobWatcher().register(ctx);

    await a.process({ id: 5, name: 'x', queueName: 'q' });
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
      async process(): Promise<string> {
        // Simulate a query/exception emitted while the job runs.
        ctx.record({ type: 'query', content: { sql: 'select 1' } });
        return 'ok';
      }
    }
    const proc = new CorrelatingProcessor();
    providers.push({ instance: proc });
    await new BullMqJobWatcher().register(ctx);

    await proc.process({ id: 9, name: 'corr', queueName: 'q' });

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
      async process(): Promise<string> {
        return 'ok';
      }
    }
    class BoomProc extends WorkerHost {
      async process(): Promise<never> {
        throw new Error('SMTP down');
      }
    }

    const okProc = new OkProc();
    const okHarness = makeHarness([{ instance: okProc }], { recordThrows: true });
    await new BullMqJobWatcher().register(okHarness.ctx);
    // Success must stay success even though record() throws.
    await expect(okProc.process({ id: 1, name: 'x', queueName: 'q' })).resolves.toBe('ok');

    const boomProc = new BoomProc();
    const boomHarness = makeHarness([{ instance: boomProc }], { recordThrows: true });
    await new BullMqJobWatcher().register(boomHarness.ctx);
    // The host's original error must propagate, not the recorder's.
    await expect(boomProc.process({ id: 2, name: 'x', queueName: 'q' })).rejects.toThrow(
      'SMTP down',
    );
  });
});
