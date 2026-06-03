// packages/bullmq/src/bull-mq-queue-manager.integration.spec.ts
//
// Integration: real @nestjs/bullmq wiring + real Redis + real TelescopeModule.
//
// This is the ONLY test that validates the real BullMQ getJobs()/getJobCounts()
// list-name strings in STATE_TO_BULL (the unit test uses a structural stub that
// would pass regardless). It enqueues a real job and reads it back through the
// discovered Queue, asserting listJobs() and getJob() return it.
//
// REQUIRES Redis. Skipped via describe.skipIf(!process.env.REDIS_URL) so CI
// without Redis stays green and reports the suite as skipped (0 failures).
//
// Bootstrap mirrors bullmq-job.watcher.integration.spec.ts: the manager is
// resolved from the registry (app.get(QueueManagerRegistry).get('bullmq')).
import 'reflect-metadata';
import {
  type QueueManager,
  QueueManagerRegistry,
  TelescopeModule,
} from '@dudousxd/nestjs-telescope';
import { BullModule, Processor, WorkerHost, getQueueToken } from '@nestjs/bullmq';
import { type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMqQueueManager } from './bull-mq-queue-manager.js';

const REDIS_URL = process.env.REDIS_URL;
const connection = REDIS_URL ? { url: REDIS_URL } : { host: '127.0.0.1', port: 6379 };

// A worker that always throws so processed jobs land in the 'failed' list.
// `attempts: 1` (set per-job at enqueue) means a single failure is terminal.
@Processor('telescope-actions')
class FailingProcessor extends WorkerHost {
  async process(): Promise<void> {
    throw new Error('intentional failure for action tests');
  }
}

@Module({
  imports: [
    TelescopeModule.forRoot({
      enabled: true,
      authorizer: () => true,
      queueManagers: [new BullMqQueueManager()],
    }),
    BullModule.forRoot({ connection }),
    BullModule.registerQueue({ name: 'telescope-test' }),
    BullModule.registerQueue({ name: 'telescope-actions' }),
  ],
  providers: [FailingProcessor],
})
class AppModule {}

/** Poll `read()` until `predicate` holds or the deadline passes. */
async function poll<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 10000, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await read();
  }
  return last;
}

describe.skipIf(!REDIS_URL)('BullMqQueueManager integration (real Redis)', () => {
  let app: INestApplication;
  let queue: Queue;
  let actionsQueue: Queue;
  let manager: QueueManager;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
    queue = moduleRef.get<Queue>(getQueueToken('telescope-test'));
    actionsQueue = moduleRef.get<Queue>(getQueueToken('telescope-actions'));
    // Start clean so counts are deterministic for this run.
    await queue.obliterate({ force: true });
    await actionsQueue.obliterate({ force: true });
    const found = app.get(QueueManagerRegistry).get('bullmq');
    expect(found).toBeDefined();
    manager = found as QueueManager;
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => {});
    await actionsQueue?.obliterate({ force: true }).catch(() => {});
    await app?.close();
  });

  it('discovers the registered queue', async () => {
    const summaries = await manager.listQueues();
    const names = summaries.map((s) => s.queue);
    expect(names).toContain('telescope-test');
  });

  it('reflects an enqueued (waiting) job in counts, listJobs, and getJob', async () => {
    // No worker is registered, so the job stays in the 'wait' list.
    const added = await queue.add('greet', { hello: 'world', password: 'hunter2' });

    const counts = await manager.counts('telescope-test');
    expect(counts.waiting).toBeGreaterThanOrEqual(1);

    const page = await manager.listJobs('telescope-test', 'waiting', { limit: 50 });
    const listed = page.jobs.find((job) => job.id === String(added.id));
    expect(listed).toBeDefined();
    expect(listed?.name).toBe('greet');
    expect(listed?.state).toBe('waiting');

    const detail = await manager.getJob('telescope-test', String(added.id));
    expect(detail).not.toBeNull();
    expect(detail?.name).toBe('greet');
    // Payload redaction is wired through the real core redact(): password masked.
    const data = detail?.data as { hello?: string; password?: string };
    expect(data.hello).toBe('world');
    expect(data.password).toBe('[REDACTED]');
  });

  it('retry() moves a failed job back out of the failed list', async () => {
    // The FailingProcessor throws, so this job ends up in 'failed' (attempts: 1).
    const added = await actionsQueue.add('boom', { n: 1 }, { attempts: 1 });
    const id = String(added.id);

    const before = await poll(
      () => manager.counts('telescope-actions'),
      (counts) => counts.failed >= 1,
    );
    expect(before.failed).toBeGreaterThanOrEqual(1);

    await manager.retry('telescope-actions', id);

    // After retry the job is re-queued (wait/active) then fails again. The
    // observable, race-free signal is that it leaves 'failed' at least once.
    const afterRetry = await poll(
      () => manager.getJob('telescope-actions', id),
      (detail) => detail !== null && detail.state !== 'failed',
    );
    expect(afterRetry).not.toBeNull();
    expect(afterRetry?.state).not.toBe('failed');
  });

  it('remove() drops a job from the queue counts', async () => {
    // Enqueue with a long delay so it sits in 'delayed' and never processes.
    const added = await actionsQueue.add('later', { n: 2 }, { delay: 60_000 });
    const id = String(added.id);

    await poll(
      () => manager.counts('telescope-actions'),
      (counts) => counts.delayed >= 1,
    );

    await manager.remove('telescope-actions', id);

    const gone = await poll(
      () => manager.getJob('telescope-actions', id),
      (detail) => detail === null,
    );
    expect(gone).toBeNull();
  });
});
