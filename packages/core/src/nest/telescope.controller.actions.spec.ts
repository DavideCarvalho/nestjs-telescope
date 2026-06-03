// packages/core/src/nest/telescope.controller.actions.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  JobPage,
  QueueCounts,
  QueueJobDetail,
  QueueManager,
  QueueState,
  QueueSummary,
} from '../queue/queue-manager.js';
import { TelescopeModule } from './telescope.module.js';
import type { TelescopeModuleOptions } from './telescope.options.js';

const COUNTS: QueueCounts = {
  waiting: 0,
  active: 0,
  delayed: 0,
  failed: 2,
  completed: 0,
  paused: 0,
};

const EMPTY_PAGE: JobPage = { jobs: [], nextCursor: null, total: null };

interface ActionSpies {
  retry: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  promote: ReturnType<typeof vi.fn>;
  retryAll: ReturnType<typeof vi.fn>;
  enqueue?: ReturnType<typeof vi.fn>;
}

// Fake manager implements retry/remove/promote/retryAll and OMITS redrive (405 path).
// `enqueue` is only wired when a spy is supplied (lets a test exercise the 404 path).
function makeManager(spies: ActionSpies): QueueManager {
  return {
    driver: 'bullmq',
    init: () => {},
    listQueues: (): Promise<QueueSummary[]> => Promise.resolve([]),
    counts: (): Promise<QueueCounts> => Promise.resolve(COUNTS),
    listJobs: (): Promise<JobPage> => Promise.resolve(EMPTY_PAGE),
    getJob: (): Promise<QueueJobDetail | null> => Promise.resolve(null),
    retry: spies.retry as unknown as (queue: string, id: string) => Promise<void>,
    remove: spies.remove as unknown as (queue: string, id: string) => Promise<void>,
    promote: spies.promote as unknown as (queue: string, id: string) => Promise<void>,
    retryAll: spies.retryAll as unknown as (queue: string, state: QueueState) => Promise<number>,
    ...(spies.enqueue
      ? {
          enqueue: spies.enqueue as unknown as QueueManager['enqueue'],
        }
      : {}),
  };
}

function baseSpies(): ActionSpies {
  return {
    retry: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    promote: vi.fn(() => Promise.resolve()),
    retryAll: vi.fn(() => Promise.resolve(0)),
  };
}

async function makeApp(options: TelescopeModuleOptions): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot(options)],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('POST /telescope/api/queues/live/* (gated mutations)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('retries a job (200) and records the call', async () => {
    const spies: ActionSpies = {
      retry: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
      promote: vi.fn(() => Promise.resolve()),
      retryAll: vi.fn(() => Promise.resolve(0)),
    };
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      authorizeAction: () => true,
      queueManagers: [makeManager(spies)],
    });
    const res = await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bullmq/q1/jobs/5/retry')
      .expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(spies.retry).toHaveBeenCalledWith('q1', '5');
  });

  it('rejects an out-of-context job action with 400', async () => {
    // `redrive` is a valid QueueActionName (passes the guard) but is not a job
    // action, so the jobs route rejects it with 400 (not the guard's 403).
    const spies: ActionSpies = {
      retry: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
      promote: vi.fn(() => Promise.resolve()),
      retryAll: vi.fn(() => Promise.resolve(0)),
    };
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      authorizeAction: () => true,
      queueManagers: [makeManager(spies)],
    });
    await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bullmq/q1/jobs/5/redrive')
      .expect(400);
  });

  it('rejects a bogus job action with 403 (guard rejects unknown action)', async () => {
    const spies: ActionSpies = {
      retry: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
      promote: vi.fn(() => Promise.resolve()),
      retryAll: vi.fn(() => Promise.resolve(0)),
    };
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      authorizeAction: () => true,
      queueManagers: [makeManager(spies)],
    });
    await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bullmq/q1/jobs/5/bogus')
      .expect(403);
  });

  it('retries all failed jobs (200) with a count', async () => {
    const spies: ActionSpies = {
      retry: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
      promote: vi.fn(() => Promise.resolve()),
      retryAll: vi.fn(() => Promise.resolve(2)),
    };
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      authorizeAction: () => true,
      queueManagers: [makeManager(spies)],
    });
    const res = await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bullmq/q1/actions/retry-all?state=failed')
      .expect(200);
    expect(res.body).toEqual({ ok: true, count: 2 });
    expect(spies.retryAll).toHaveBeenCalledWith('q1', 'failed');
  });

  it('returns 405 for redrive when the driver omits it', async () => {
    const spies: ActionSpies = {
      retry: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
      promote: vi.fn(() => Promise.resolve()),
      retryAll: vi.fn(() => Promise.resolve(0)),
    };
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      authorizeAction: () => true,
      queueManagers: [makeManager(spies)],
    });
    await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bullmq/q1/actions/redrive')
      .expect(405);
  });

  it('is 403 by default when no authorizeAction is configured', async () => {
    const spies: ActionSpies = {
      retry: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
      promote: vi.fn(() => Promise.resolve()),
      retryAll: vi.fn(() => Promise.resolve(0)),
    };
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      queueManagers: [makeManager(spies)],
    });
    await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bullmq/q1/jobs/5/retry')
      .expect(403);
    expect(spies.retry).not.toHaveBeenCalled();
  });

  it('is 403 when authorizeAction returns false', async () => {
    const spies: ActionSpies = {
      retry: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
      promote: vi.fn(() => Promise.resolve()),
      retryAll: vi.fn(() => Promise.resolve(0)),
    };
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      authorizeAction: () => false,
      queueManagers: [makeManager(spies)],
    });
    await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bullmq/q1/jobs/5/retry')
      .expect(403);
    expect(spies.retry).not.toHaveBeenCalled();
  });

  it('enqueues a job (200) and calls manager.enqueue with name + payload', async () => {
    const spies = baseSpies();
    spies.enqueue = vi.fn(() => Promise.resolve({ id: '42' }));
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      authorizeAction: () => true,
      queueManagers: [makeManager(spies)],
    });
    const res = await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bullmq/q1/enqueue')
      .send({ name: 'send-email', payload: { to: 'a@b.c' } })
      .expect(200);
    expect(res.body).toEqual({ id: '42' });
    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    expect(spies.enqueue.mock.calls[0]![0]).toBe('q1');
    expect(spies.enqueue.mock.calls[0]![1]).toEqual({ to: 'a@b.c' });
    expect(spies.enqueue.mock.calls[0]![2]).toEqual({ name: 'send-email' });
  });

  it('is 403 for enqueue when no authorizeAction is configured', async () => {
    const spies = baseSpies();
    spies.enqueue = vi.fn(() => Promise.resolve({ id: '1' }));
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      queueManagers: [makeManager(spies)],
    });
    await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bullmq/q1/enqueue')
      .send({ payload: { ok: true } })
      .expect(403);
    expect(spies.enqueue).not.toHaveBeenCalled();
  });

  it('is 400 for enqueue when the payload is absent', async () => {
    const spies = baseSpies();
    spies.enqueue = vi.fn(() => Promise.resolve({ id: '1' }));
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      authorizeAction: () => true,
      queueManagers: [makeManager(spies)],
    });
    await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bullmq/q1/enqueue')
      .send({ name: 'x' })
      .expect(400);
    expect(spies.enqueue).not.toHaveBeenCalled();
  });

  it('is 404 for enqueue against an unknown driver', async () => {
    const spies = baseSpies();
    spies.enqueue = vi.fn(() => Promise.resolve({ id: '1' }));
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      authorizeAction: () => true,
      queueManagers: [makeManager(spies)],
    });
    await request(app.getHttpServer())
      .post('/telescope/api/queues/live/nope/q1/enqueue')
      .send({ payload: {} })
      .expect(404);
  });

  it('is 404 for enqueue when the driver does not implement it', async () => {
    const spies = baseSpies(); // no enqueue spy → manager omits enqueue
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      authorizeAction: () => true,
      queueManagers: [makeManager(spies)],
    });
    await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bullmq/q1/enqueue')
      .send({ payload: {} })
      .expect(404);
  });
});
