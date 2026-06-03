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
}

// Fake manager implements retry/remove/promote/retryAll and OMITS redrive (405 path).
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
});
