// packages/bullmq/src/bull-mq-queue-manager.spec.ts
//
// CI-safe unit test. The BullMQ Queue is replaced by a structural stub, so this
// suite runs without Redis. It does NOT validate the real getJobs() list-name
// strings — that is the integration test's job. It DOES validate the mapping,
// pagination cursor, the unknown-queue guard, and (security property) that job
// payloads pass through ctx.redact before leaving the manager.
import 'reflect-metadata';
import type { QueueManagerContext } from '@dudousxd/nestjs-telescope';
import type { DiscoveryService, ModuleRef } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { BullMqQueueManager } from './bull-mq-queue-manager.js';
import type { QueueLike } from './queue-discovery.js';

interface StubJob {
  id?: string;
  name?: string;
  data?: unknown;
  opts?: { attempts?: number };
  attemptsMade?: number;
  failedReason?: string;
  stacktrace?: string[];
  returnvalue?: unknown;
}

function makeQueueStub(
  name: string,
  config: {
    counts?: Record<string, number>;
    jobsByType?: Record<string, StubJob[]>;
    jobsById?: Record<string, StubJob>;
    paused?: boolean;
  } = {},
): QueueLike {
  return {
    name,
    getJobCounts: async (...types: string[]) => {
      const result: Record<string, number> = {};
      for (const type of types) result[type] = config.counts?.[type] ?? 0;
      return result;
    },
    getJobs: async (types: string | string[]) => {
      const key = Array.isArray(types) ? types[0] : types;
      return config.jobsByType?.[key ?? ''] ?? [];
    },
    getJob: async (id: string) => config.jobsById?.[id] ?? null,
    isPaused: async () => config.paused ?? false,
  };
}

/** A ModuleRef whose get(DiscoveryService) yields a stub exposing getProviders(). */
function makeContext(
  queues: QueueLike[],
  redact: (value: unknown) => unknown = (value) => value,
): QueueManagerContext {
  const discovery = {
    getProviders: () => queues.map((instance) => ({ instance })),
  } as unknown as DiscoveryService;
  const moduleRef = { get: () => discovery } as unknown as ModuleRef;
  return {
    moduleRef,
    config: {} as QueueManagerContext['config'],
    redact,
  };
}

describe('BullMqQueueManager', () => {
  it('has driver "bullmq"', () => {
    expect(new BullMqQueueManager().driver).toBe('bullmq');
  });

  it('discovers all queues and maps counts + isPaused in listQueues()', async () => {
    const q1 = makeQueueStub('q1', { counts: { waiting: 2, active: 1, failed: 3 }, paused: false });
    const q2 = makeQueueStub('q2', { counts: { completed: 7 }, paused: true });
    const manager = new BullMqQueueManager();
    manager.init(makeContext([q1, q2]));

    const summaries = await manager.listQueues();

    expect(summaries).toHaveLength(2);
    const byName = new Map(summaries.map((s) => [s.queue, s]));
    expect(byName.get('q1')).toMatchObject({
      driver: 'bullmq',
      queue: 'q1',
      isPaused: false,
      counts: { waiting: 2, active: 1, delayed: 0, failed: 3, completed: 0, paused: 0 },
    });
    expect(byName.get('q2')).toMatchObject({
      isPaused: true,
      counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 7, paused: 0 },
    });
  });

  it('honours an explicit queue allow-list', async () => {
    const q1 = makeQueueStub('q1');
    const q2 = makeQueueStub('q2');
    const manager = new BullMqQueueManager(['q2']);
    manager.init(makeContext([q1, q2]));

    const summaries = await manager.listQueues();
    expect(summaries.map((s) => s.queue)).toEqual(['q2']);
  });

  it('counts() maps a single queue', async () => {
    const q1 = makeQueueStub('q1', { counts: { waiting: 5, delayed: 4 } });
    const manager = new BullMqQueueManager();
    manager.init(makeContext([q1]));

    await expect(manager.counts('q1')).resolves.toMatchObject({
      waiting: 5,
      delayed: 4,
      active: 0,
    });
  });

  it('listJobs() maps jobs and sets nextCursor when more exist', async () => {
    const failed: StubJob[] = [
      { id: '10', name: 'send', attemptsMade: 2, opts: { attempts: 3 }, failedReason: 'boom' },
      { id: '11', name: 'send', attemptsMade: 1 },
    ];
    // limit=1 → fetch start..start+1 (2 jobs), slice to 1, signal next page.
    const q1 = makeQueueStub('q1', { jobsByType: { failed } });
    const manager = new BullMqQueueManager();
    manager.init(makeContext([q1]));

    const page = await manager.listJobs('q1', 'failed', { limit: 1 });

    expect(page.jobs).toHaveLength(1);
    expect(page.jobs[0]).toMatchObject({
      id: '10',
      name: 'send',
      state: 'failed',
      attemptsMade: 2,
      maxAttempts: 3,
      failedReason: 'boom',
    });
    expect(page.nextCursor).toBe('1');
    expect(page.total).toBeNull();
  });

  it('listJobs() returns null cursor when no further page', async () => {
    const q1 = makeQueueStub('q1', { jobsByType: { failed: [{ id: '1', name: 'a' }] } });
    const manager = new BullMqQueueManager();
    manager.init(makeContext([q1]));

    const page = await manager.listJobs('q1', 'failed', { limit: 50 });
    expect(page.jobs).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('getJob() redacts data and exposes opts/stacktrace/returnValue', async () => {
    const job: StubJob = {
      id: '5',
      name: 'login',
      data: { user: 'ada', password: 'hunter2' },
      opts: { attempts: 4 },
      attemptsMade: 1,
      stacktrace: ['at foo', 'at bar'],
      returnvalue: { ok: true },
    };
    const q1 = makeQueueStub('q1', { jobsById: { '5': job } });
    const manager = new BullMqQueueManager();
    // A redactor that masks the password field, like core's redact().
    manager.init(
      makeContext([q1], (value) => {
        if (typeof value === 'object' && value !== null && 'password' in value) {
          return { ...(value as Record<string, unknown>), password: '[REDACTED]' };
        }
        return value;
      }),
    );

    const detail = await manager.getJob('q1', '5');

    expect(detail).not.toBeNull();
    expect(detail?.id).toBe('5');
    expect(detail?.data).toEqual({ user: 'ada', password: '[REDACTED]' });
    expect(detail?.opts).toEqual({ attempts: 4 });
    expect(detail?.maxAttempts).toBe(4);
    expect(detail?.stacktrace).toEqual(['at foo', 'at bar']);
    expect(detail?.returnValue).toEqual({ ok: true });
  });

  it('getJob() returns null when the job is absent', async () => {
    const q1 = makeQueueStub('q1', { jobsById: {} });
    const manager = new BullMqQueueManager();
    manager.init(makeContext([q1]));

    await expect(manager.getJob('q1', 'nope')).resolves.toBeNull();
  });

  it('retry/remove/promote resolve the job and call the matching bullmq op', async () => {
    const retry = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const promote = vi.fn(async () => {});
    const job = { id: '5', retry, remove, promote };
    const q1: QueueLike = {
      ...makeQueueStub('q1'),
      getJob: async (id: string) => (id === '5' ? job : null),
    };
    const manager = new BullMqQueueManager();
    manager.init(makeContext([q1]));

    await manager.retry('q1', '5');
    await manager.remove('q1', '5');
    await manager.promote('q1', '5');

    expect(retry).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(promote).toHaveBeenCalledOnce();
  });

  it('retryAll calls retryJobs with the bull state and returns the pre-count', async () => {
    const retryJobs = vi.fn(async () => {});
    const q1: QueueLike = {
      ...makeQueueStub('q1', { counts: { failed: 7 } }),
      retryJobs,
    };
    const manager = new BullMqQueueManager();
    manager.init(makeContext([q1]));

    const count = await manager.retryAll('q1', 'failed');

    expect(retryJobs).toHaveBeenCalledWith({ state: 'failed' });
    expect(count).toBe(7);
  });

  it('enqueue() adds a job with the given name + payload and returns its id', async () => {
    const add = vi.fn(async (_name: string, _data: unknown) => ({ id: '99' }));
    const q1: QueueLike = { ...makeQueueStub('q1'), add };
    const manager = new BullMqQueueManager();
    manager.init(makeContext([q1]));

    const result = await manager.enqueue('q1', { to: 'a@b.c' }, { name: 'send-email' });

    expect(add).toHaveBeenCalledWith('send-email', { to: 'a@b.c' });
    expect(result).toEqual({ id: '99' });
  });

  it('enqueue() defaults the job name to "manual" and null-coalesces a missing id', async () => {
    const add = vi.fn(async (_name: string, _data: unknown) => ({}));
    const q1: QueueLike = { ...makeQueueStub('q1'), add };
    const manager = new BullMqQueueManager();
    manager.init(makeContext([q1]));

    const result = await manager.enqueue('q1', { x: 1 }, {});

    expect(add).toHaveBeenCalledWith('manual', { x: 1 });
    expect(result).toEqual({ id: null });
  });

  it('throws when a job action targets a missing job', async () => {
    const q1: QueueLike = {
      ...makeQueueStub('q1'),
      getJob: async () => null,
    };
    const manager = new BullMqQueueManager();
    manager.init(makeContext([q1]));

    await expect(manager.retry('q1', 'nope')).rejects.toThrow('Job nope not found in q1');
    await expect(manager.remove('q1', 'nope')).rejects.toThrow('Job nope not found in q1');
    await expect(manager.promote('q1', 'nope')).rejects.toThrow('Job nope not found in q1');
  });

  it('throws for an unknown queue', async () => {
    const manager = new BullMqQueueManager();
    manager.init(makeContext([makeQueueStub('q1')]));

    // counts() is non-async and requireQueue throws synchronously; wrap so the
    // throw surfaces whether it rejects or throws.
    await expect((async () => manager.counts('ghost'))()).rejects.toThrow(
      'Unknown bullmq queue: ghost',
    );
  });
});
