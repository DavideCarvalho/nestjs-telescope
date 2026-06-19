// packages/core/src/nest/telescope.controller.queues-live.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  JobPage,
  QueueCounts,
  QueueJobDetail,
  QueueManager,
  QueueSummary,
} from '../queue/queue-manager.js';
import { TelescopeModule } from './telescope.module.js';

const COUNTS: QueueCounts = {
  waiting: 3,
  active: 1,
  delayed: 0,
  failed: 2,
  completed: 10,
  paused: 0,
};

const SUMMARY: QueueSummary = {
  driver: 'bull',
  queue: 'q1',
  counts: COUNTS,
  isPaused: false,
};

const FAILED_PAGE: JobPage = {
  jobs: [
    {
      id: '7',
      name: 'send-email',
      state: 'failed',
      attemptsMade: 3,
      maxAttempts: 3,
      timestamp: 1,
      processedOn: 2,
      finishedOn: 3,
      failedReason: 'SMTP down',
      progress: null,
    },
  ],
  nextCursor: null,
  total: null,
};

const JOB_DETAIL: QueueJobDetail = {
  id: '123',
  name: 'send-email',
  state: 'completed',
  attemptsMade: 1,
  maxAttempts: 3,
  timestamp: 1,
  processedOn: 2,
  finishedOn: 3,
  failedReason: null,
  progress: 100,
  data: { to: 'a@b.c' },
  opts: { attempts: 3 },
  stacktrace: null,
  returnValue: { ok: true },
};

const fakeManager: QueueManager = {
  driver: 'bull',
  init: () => {},
  listQueues: (): Promise<QueueSummary[]> => Promise.resolve([SUMMARY]),
  counts: (): Promise<QueueCounts> => Promise.resolve(COUNTS),
  listJobs: (): Promise<JobPage> => Promise.resolve(FAILED_PAGE),
  getJob: (): Promise<QueueJobDetail | null> => Promise.resolve(JOB_DETAIL),
};

describe('GET /telescope/api/queues/live/*', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          queueManagers: [fakeManager],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists live queues across drivers with capabilities', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/api/queues/live').expect(200);
    expect(res.body).toEqual({
      queues: [SUMMARY],
      capabilities: { mutationsEnabled: false, actionsByDriver: { bull: [] } },
    });
  });

  it('returns counts for a known driver/queue', async () => {
    const res = await request(app.getHttpServer())
      .get('/telescope/api/queues/live/bull/q1/counts')
      .expect(200);
    expect(res.body).toEqual(COUNTS);
  });

  it('returns a job page for a valid state', async () => {
    const res = await request(app.getHttpServer())
      .get('/telescope/api/queues/live/bull/q1/jobs?state=failed')
      .expect(200);
    expect(res.body).toEqual(FAILED_PAGE);
  });

  it('rejects an invalid state with 400', async () => {
    await request(app.getHttpServer())
      .get('/telescope/api/queues/live/bull/q1/jobs?state=bogus')
      .expect(400);
  });

  it('returns 404 for an unknown driver', async () => {
    await request(app.getHttpServer()).get('/telescope/api/queues/live/nope/q1/counts').expect(404);
  });

  it('returns a single job detail', async () => {
    const res = await request(app.getHttpServer())
      .get('/telescope/api/queues/live/bull/q1/jobs/123')
      .expect(200);
    expect(res.body).toEqual(JOB_DETAIL);
  });
});

const bullmqManager: QueueManager = {
  driver: 'bullmq',
  init: () => {},
  listQueues: (): Promise<QueueSummary[]> => Promise.resolve([{ ...SUMMARY, driver: 'bullmq' }]),
  counts: (): Promise<QueueCounts> => Promise.resolve(COUNTS),
  listJobs: (): Promise<JobPage> => Promise.resolve(FAILED_PAGE),
  getJob: (): Promise<QueueJobDetail | null> => Promise.resolve(JOB_DETAIL),
  // implements retry + enqueue but NOT redrive:
  retry: (): Promise<void> => Promise.resolve(),
  enqueue: (): Promise<{ id: string | null }> => Promise.resolve({ id: '1' }),
};

describe('GET /telescope/api/queues/live capabilities', () => {
  it('advertises only implemented actions per driver', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          queueManagers: [bullmqManager],
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const res = await request(app.getHttpServer()).get('/telescope/api/queues/live').expect(200);
      expect(res.body.capabilities.actionsByDriver.bullmq).toContain('retry');
      expect(res.body.capabilities.actionsByDriver.bullmq).toContain('enqueue');
      expect(res.body.capabilities.actionsByDriver.bullmq).not.toContain('redrive');
    } finally {
      await app.close();
    }
  });

  it('reports mutationsEnabled=false when authorizeAction is omitted', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          queueManagers: [bullmqManager],
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const res = await request(app.getHttpServer()).get('/telescope/api/queues/live').expect(200);
      expect(res.body.capabilities.mutationsEnabled).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('reports mutationsEnabled=true when authorizeAction is configured', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          authorizeAction: () => true,
          queueManagers: [bullmqManager],
        }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const res = await request(app.getHttpServer()).get('/telescope/api/queues/live').expect(200);
      expect(res.body.capabilities.mutationsEnabled).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('POST /telescope/api/queues/live/:driver/:queue/jobs/:id/:action', () => {
  let app: INestApplication;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  // Implements retry + remove, but NOT promote (to exercise the 405 path).
  const actionManager: QueueManager = {
    driver: 'bull',
    init: () => {},
    listQueues: (): Promise<QueueSummary[]> => Promise.resolve([SUMMARY]),
    counts: (): Promise<QueueCounts> => Promise.resolve(COUNTS),
    listJobs: (): Promise<JobPage> => Promise.resolve(FAILED_PAGE),
    getJob: (): Promise<QueueJobDetail | null> => Promise.resolve(JOB_DETAIL),
    retry: (queue: string, id: string): Promise<void> => {
      calls.push({ method: 'retry', args: [queue, id] });
      return Promise.resolve();
    },
    remove: (queue: string, id: string): Promise<void> => {
      calls.push({ method: 'remove', args: [queue, id] });
      return Promise.resolve();
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          authorizeAction: () => true,
          queueManagers: [actionManager],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('dispatches retry to the manager method with (queue, id)', async () => {
    calls.length = 0;
    await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bull/q1/jobs/7/retry')
      .expect(200)
      .expect({ ok: true });
    expect(calls).toEqual([{ method: 'retry', args: ['q1', '7'] }]);
  });

  it('dispatches remove to the manager method with (queue, id)', async () => {
    calls.length = 0;
    await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bull/q1/jobs/7/remove')
      .expect(200);
    expect(calls).toEqual([{ method: 'remove', args: ['q1', '7'] }]);
  });

  it('returns 405 when the driver does not implement the per-job action', async () => {
    await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bull/q1/jobs/7/promote')
      .expect(405);
  });

  it('rejects a non-per-job action (retry-all) on the per-job route with 400', async () => {
    await request(app.getHttpServer())
      .post('/telescope/api/queues/live/bull/q1/jobs/7/retry-all')
      .expect(400);
  });
});
