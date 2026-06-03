// packages/sqs/src/sqs-queue-manager.spec.ts
//
// CI-safe unit test. The SQS SDK is never touched: the manager depends only on
// the `SqsOps` port, which we supply as a mock. This validates the DLQ-only
// semantics (non-failed states are empty), count mapping, the
// snapshot→cache→getJob flow, redaction of DLQ bodies (security property), and
// that redrive resolves both ARNs and returns the pre-redrive failed count.
import 'reflect-metadata';
import type { QueueManagerContext } from '@dudousxd/nestjs-telescope';
import type { ModuleRef } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { SqsApproximateCounts, SqsDlqMessage, SqsOps } from './sqs-client.js';
import { SqsQueueManager } from './sqs-queue-manager.js';

function makeOps(overrides: Partial<SqsOps> = {}): SqsOps {
  return {
    approximateCounts: async (): Promise<SqsApproximateCounts> => ({
      visible: 0,
      notVisible: 0,
      delayed: 0,
    }),
    receiveDlq: async (): Promise<SqsDlqMessage[]> => [],
    redrive: async (): Promise<void> => {},
    queueArn: async (url: string): Promise<string> => `arn:${url}`,
    ...overrides,
  };
}

function makeContext(redact: (value: unknown) => unknown = (value) => value): QueueManagerContext {
  return {
    moduleRef: {} as unknown as ModuleRef,
    config: {} as QueueManagerContext['config'],
    redact,
  };
}

const QUEUES = [{ name: 'mail', url: 'https://sqs/mail', dlqUrl: 'https://sqs/mail-dlq' }];

/** A queue with no DLQ — only live main-queue depth is observable. */
const QUEUES_NO_DLQ = [{ name: 'events', url: 'https://sqs/events' }];

describe('SqsQueueManager', () => {
  it('has driver "sqs"', () => {
    const manager = new SqsQueueManager({ ops: makeOps(), queues: QUEUES });
    expect(manager.driver).toBe('sqs');
  });

  it('maps source visible/in-flight + DLQ visible into counts in listQueues()', async () => {
    const approximateCounts = vi.fn(async (url: string): Promise<SqsApproximateCounts> => {
      if (url === 'https://sqs/mail') return { visible: 4, notVisible: 2, delayed: 6 };
      if (url === 'https://sqs/mail-dlq') return { visible: 7, notVisible: 1, delayed: 0 };
      return { visible: 0, notVisible: 0, delayed: 0 };
    });
    const manager = new SqsQueueManager({ ops: makeOps({ approximateCounts }), queues: QUEUES });
    manager.init(makeContext());

    const summaries = await manager.listQueues();

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      driver: 'sqs',
      queue: 'mail',
      isPaused: false,
      counts: { waiting: 4, active: 2, delayed: 6, failed: 7, completed: 0, paused: 0 },
      actions: ['redrive'],
    });
  });

  it('counts() maps a single queue', async () => {
    const approximateCounts = vi.fn(
      async (url: string): Promise<SqsApproximateCounts> =>
        url === 'https://sqs/mail-dlq'
          ? { visible: 3, notVisible: 0, delayed: 0 }
          : { visible: 9, notVisible: 0, delayed: 2 },
    );
    const manager = new SqsQueueManager({ ops: makeOps({ approximateCounts }), queues: QUEUES });
    manager.init(makeContext());

    await expect(manager.counts('mail')).resolves.toMatchObject({
      waiting: 9,
      failed: 3,
      active: 0,
      delayed: 2,
    });
  });

  it('listJobs() returns an empty page for any non-failed state', async () => {
    const receiveDlq = vi.fn(async (): Promise<SqsDlqMessage[]> => []);
    const manager = new SqsQueueManager({ ops: makeOps({ receiveDlq }), queues: QUEUES });
    manager.init(makeContext());

    for (const state of ['waiting', 'active', 'delayed', 'completed', 'paused'] as const) {
      const page = await manager.listJobs('mail', state, { limit: 10 });
      expect(page).toEqual({ jobs: [], nextCursor: null, total: null });
    }
    expect(receiveDlq).not.toHaveBeenCalled();
  });

  it('listJobs("failed") snapshots the DLQ, maps + redacts, and caches for getJob', async () => {
    const receiveDlq = vi.fn(
      async (): Promise<SqsDlqMessage[]> => [
        {
          id: 'm-1',
          body: JSON.stringify({ user: 'ada', password: 'hunter2' }),
          attributes: { ApproximateReceiveCount: '3' },
        },
        { id: 'm-2', body: 'not-json' },
      ],
    );
    const redact = (value: unknown): unknown => {
      if (typeof value === 'object' && value !== null && 'password' in value) {
        return { ...(value as Record<string, unknown>), password: '[REDACTED]' };
      }
      return value;
    };
    const manager = new SqsQueueManager({
      ops: makeOps({
        receiveDlq,
        approximateCounts: async () => ({ visible: 2, notVisible: 0, delayed: 0 }),
      }),
      queues: QUEUES,
    });
    manager.init(makeContext(redact));

    const page = await manager.listJobs('mail', 'failed', { limit: 10 });

    expect(receiveDlq).toHaveBeenCalledWith('https://sqs/mail-dlq', 10);
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBeNull();
    expect(page.jobs).toHaveLength(2);
    expect(page.jobs[0]).toMatchObject({
      id: 'm-1',
      name: 'mail',
      state: 'failed',
      attemptsMade: 3,
      maxAttempts: null,
    });
    expect(page.jobs[1]).toMatchObject({ id: 'm-2', attemptsMade: 0 });

    // getJob reads from the cache populated by the snapshot, and redacts the body.
    const detail = await manager.getJob('mail', 'm-1');
    expect(detail).not.toBeNull();
    expect(detail?.data).toEqual({ user: 'ada', password: '[REDACTED]' });
    expect(detail?.opts).toBeNull();
    expect(detail?.stacktrace).toBeNull();
    expect(detail?.returnValue).toBeNull();

    // Non-JSON body comes back as the raw string.
    const rawDetail = await manager.getJob('mail', 'm-2');
    expect(rawDetail?.data).toBe('not-json');
  });

  it('caps the DLQ receive limit at 10', async () => {
    const receiveDlq = vi.fn(async (): Promise<SqsDlqMessage[]> => []);
    const manager = new SqsQueueManager({ ops: makeOps({ receiveDlq }), queues: QUEUES });
    manager.init(makeContext());

    await manager.listJobs('mail', 'failed', { limit: 500 });
    expect(receiveDlq).toHaveBeenCalledWith('https://sqs/mail-dlq', 10);
  });

  it('getJob() returns null when the message is not in the snapshot cache', async () => {
    const manager = new SqsQueueManager({ ops: makeOps(), queues: QUEUES });
    manager.init(makeContext());

    await expect(manager.getJob('mail', 'never-seen')).resolves.toBeNull();
  });

  it('redrive() resolves dlqArn + sourceArn, calls ops.redrive, and returns the pre-count', async () => {
    const redrive = vi.fn(async (): Promise<void> => {});
    const queueArn = vi.fn(
      async (url: string): Promise<string> =>
        url === 'https://sqs/mail-dlq' ? 'arn:dlq' : 'arn:source',
    );
    const approximateCounts = vi.fn(
      async (): Promise<SqsApproximateCounts> => ({
        visible: 5,
        notVisible: 0,
        delayed: 0,
      }),
    );
    const manager = new SqsQueueManager({
      ops: makeOps({ redrive, queueArn, approximateCounts }),
      queues: QUEUES,
    });
    manager.init(makeContext());

    const count = await manager.redrive('mail');

    expect(redrive).toHaveBeenCalledWith('arn:dlq', 'arn:source');
    expect(count).toBe(5);
  });

  describe('queue without a DLQ', () => {
    it('reports live main-queue depth with failed:0 and empty actions', async () => {
      const approximateCounts = vi.fn(async (url: string): Promise<SqsApproximateCounts> => {
        if (url === 'https://sqs/events') return { visible: 11, notVisible: 4, delayed: 8 };
        return { visible: 0, notVisible: 0, delayed: 0 };
      });
      const manager = new SqsQueueManager({
        ops: makeOps({ approximateCounts }),
        queues: QUEUES_NO_DLQ,
      });
      manager.init(makeContext());

      const summaries = await manager.listQueues();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        driver: 'sqs',
        queue: 'events',
        isPaused: false,
        counts: { waiting: 11, active: 4, delayed: 8, failed: 0, completed: 0, paused: 0 },
        actions: [],
      });

      // The DLQ URL is never queried — there isn't one.
      expect(approximateCounts).toHaveBeenCalledTimes(1);
      expect(approximateCounts).toHaveBeenCalledWith('https://sqs/events');

      await expect(manager.counts('events')).resolves.toMatchObject({
        waiting: 11,
        active: 4,
        delayed: 8,
        failed: 0,
      });
    });

    it('listJobs("failed") is empty (no DLQ to snapshot)', async () => {
      const receiveDlq = vi.fn(async (): Promise<SqsDlqMessage[]> => []);
      const manager = new SqsQueueManager({
        ops: makeOps({ receiveDlq }),
        queues: QUEUES_NO_DLQ,
      });
      manager.init(makeContext());

      const page = await manager.listJobs('events', 'failed', { limit: 10 });
      expect(page).toEqual({ jobs: [], nextCursor: null, total: null });
      expect(receiveDlq).not.toHaveBeenCalled();
    });

    it('redrive throws "no DLQ configured"', async () => {
      const redrive = vi.fn(async (): Promise<void> => {});
      const manager = new SqsQueueManager({
        ops: makeOps({ redrive }),
        queues: QUEUES_NO_DLQ,
      });
      manager.init(makeContext());

      await expect(manager.redrive('events')).rejects.toThrow(
        'Queue "events" has no DLQ configured; redrive unavailable',
      );
      expect(redrive).not.toHaveBeenCalled();
    });
  });

  it('throws for an unknown queue', async () => {
    const manager = new SqsQueueManager({ ops: makeOps(), queues: QUEUES });
    manager.init(makeContext());

    await expect((async () => manager.counts('ghost'))()).rejects.toThrow(
      'Unknown sqs queue: ghost',
    );
  });
});
