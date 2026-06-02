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
class EmailProcessor extends WorkerHost {
  public calls = 0;
  // biome-ignore lint/suspicious/noExplicitAny: test stub mirrors BullMQ Job shape loosely
  async process(job: any): Promise<string> {
    this.calls++;
    if (job?.data?.boom) throw new Error('SMTP down');
    return 'ok';
  }
}

class NotAProcessor {
  async process(): Promise<void> {}
}

interface Harness {
  ctx: WatcherContext;
  recorded: RecordInput[];
  origins: BatchOrigin[];
}

function makeHarness(providers: Array<{ instance: unknown }>): Harness {
  const recorded: RecordInput[] = [];
  const origins: BatchOrigin[] = [];
  const discovery = {
    getProviders: () => providers,
  } as unknown as DiscoveryService;

  const ctx: WatcherContext = {
    record: (input) => recorded.push(input),
    runInBatch: <T>(origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => {
      origins.push(origin);
      return fn();
    },
    beginBatch: (): BatchHandle => ({ id: 'batch', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: { get: () => discovery } as unknown as WatcherContext['moduleRef'],
  };
  return { ctx, recorded, origins };
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
});
