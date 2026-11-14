import type { ModuleRef } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
// packages/core/src/nest/telescope.controller.spec.ts
import { AiUsageService } from '../agent-metrics/ai-usage.service.js';
import type { ResolvedCoreConfig } from '../config/options.js';
import { resolveConfig } from '../config/resolve-config.js';
import type { Entry } from '../entry/entry.js';
import { ExtensionRegistry } from '../extension/registry.js';
import type { ExtensionContext } from '../extension/types.js';
import type { QueueMetricsService } from '../metrics/queue-metrics.service.js';
import type { ServerStatsService } from '../metrics/server-stats.service.js';
import type { StatsService } from '../metrics/stats.service.js';
import type { TimeseriesService } from '../metrics/timeseries.service.js';
import type { TracesService } from '../metrics/traces.service.js';
import type { ProfilerService } from '../profiling/profiler.service.js';
import type { PulseService } from '../pulse/pulse.service.js';
import type { QueueManagerRegistry } from '../queue/queue-manager.registry.js';
import type { ScheduleManagerRegistry } from '../schedule/schedule-manager.registry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { TelescopePruner } from './telescope-pruner.service.js';
import { TelescopeController } from './telescope.controller.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'id',
    batchId: 'b',
    type: 'request',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function setup() {
  const storage = new InMemoryStorageProvider();
  const extensions = new ExtensionRegistry([], {} as ExtensionContext);
  const service = new TelescopeService(resolveConfig({}), storage, {}, extensions);
  // Only list()/show()/meta() are exercised below, and they touch just
  // `storage` and `service`. The remaining constructor deps are unused by
  // those paths, so they're stubbed rather than wired up for real.
  const controller = new TelescopeController(
    storage,
    service,
    {} as QueueMetricsService,
    {} as TimeseriesService,
    {} as TracesService,
    {} as StatsService,
    {} as ServerStatsService,
    {} as PulseService,
    {} as ProfilerService,
    {} as QueueManagerRegistry,
    {} as ScheduleManagerRegistry,
    {} as TelescopeModuleOptions,
    extensions,
    {} as ResolvedCoreConfig,
    {} as TelescopePruner,
    new AiUsageService(storage),
    {} as ModuleRef,
  );
  return { storage, controller };
}

describe('TelescopeController', () => {
  it('lists entries filtered by type', async () => {
    const { storage, controller } = setup();
    await storage.store([entry({ id: '1', type: 'request' }), entry({ id: '2', type: 'query' })]);
    const page = await controller.list({ filter: { type: 'query' } });
    expect(page.data.map((e) => e.id)).toEqual(['2']);
  });

  it('lists entries filtered by traceId', async () => {
    const { storage, controller } = setup();
    await storage.store([
      entry({ id: 'a1', traceId: 'trace-A' }),
      entry({ id: 'b1', traceId: 'trace-B' }),
      entry({ id: 'none', traceId: null }),
    ]);
    const page = await controller.list({ filter: { traceId: 'trace-A' } });
    expect(page.data.map((e) => e.id)).toEqual(['a1']);
  });

  it('lists entries filtered by free-text search over content', async () => {
    const { storage, controller } = setup();
    await storage.store([
      entry({ id: 'req', type: 'request', content: { uri: '/api/orders' } }),
      entry({ id: 'sql', type: 'query', content: { sql: 'select * from users' } }),
    ]);
    const page = await controller.list({ search: 'orders' });
    expect(page.data.map((e) => e.id)).toEqual(['req']);
  });

  it('ignores an empty search param', async () => {
    const { storage, controller } = setup();
    await storage.store([entry({ id: '1' }), entry({ id: '2' })]);
    const page = await controller.list({ search: '' });
    expect(page.data).toHaveLength(2);
  });

  it('pages with after/first and answers the cursor envelope', async () => {
    const { storage, controller } = setup();
    await storage.store([
      entry({ id: '1', createdAt: new Date(1000) }),
      entry({ id: '2', createdAt: new Date(2000) }),
      entry({ id: '3', createdAt: new Date(3000) }),
    ]);
    const first = await controller.list({ first: '2' });
    expect(first.data.map((e) => e.id)).toEqual(['3', '2']);
    expect(first.meta).toEqual({
      nextCursor: expect.any(String),
      prevCursor: null,
      hasNext: true,
      hasPrev: false,
    });
    const second = await controller.list({ first: '2', after: first.meta.nextCursor });
    expect(second.data.map((e) => e.id)).toEqual(['1']);
  });

  it('caps first at 500', async () => {
    const { storage, controller } = setup();
    const get = vi.spyOn(storage, 'get');
    await controller.list({ first: '100000' });
    expect(get.mock.calls[0]?.[0].limit).toBe(500);
  });

  it.each([
    [{ type: 'query' }, /filter\[type\]/],
    [{ cursor: 'x' }, /"after"/],
    [{ limit: '10' }, /"first"/],
    [{ first: 'abc' }, /first/],
    [{ before: 'x' }, /forward only/],
    [{ filter: { status: 'x' } }, /unknown field "status"/],
  ])('rejects %j with a 400', async (query, message) => {
    const { controller } = setup();
    await expect(controller.list(query as Record<string, unknown>)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(message),
    });
  });

  it('returns an entry with its batch', async () => {
    const { storage, controller } = setup();
    await storage.store([
      entry({ id: '1', batchId: 'b', sequence: 0 }),
      entry({ id: '2', batchId: 'b', sequence: 1 }),
    ]);
    const found = await controller.show('1');
    expect(found?.batch.map((e) => e.id)).toEqual(['1', '2']);
  });

  it('exposes meta', async () => {
    const { controller } = setup();
    const meta = await controller.meta();
    expect(meta.enabled).toBe(true);
  });
});

describe('TelescopeController tags', () => {
  async function seeded() {
    const { storage, controller } = setup();
    await storage.store([
      entry({ id: '1', tags: ['user:a', 'user:b', 'slow'] }),
      entry({ id: '2', tags: ['user:a', 'user:c'] }),
      entry({ id: '3', tags: ['user:a'] }),
    ]);
    return { storage, controller };
  }

  it('pages tags with an opaque cursor, most-used first', async () => {
    const { controller } = await seeded();
    const first = await controller.tags({ 'filter[tag][startsWith]': 'user:', first: '2' });
    expect(first.data).toEqual([
      { tag: 'user:a', count: 3 },
      { tag: 'user:b', count: 1 },
    ]);
    expect(first.meta).toMatchObject({ hasNext: true, hasPrev: false, prevCursor: null });
    const second = await controller.tags({
      filter: { tag: { startsWith: 'user:' } },
      first: '2',
      after: first.meta.nextCursor,
    });
    expect(second.data).toEqual([{ tag: 'user:c', count: 1 }]);
    // forward-only: `before` is a 400, so no page ever advertises a previous one
    expect(second.meta).toMatchObject({
      nextCursor: null,
      prevCursor: null,
      hasNext: false,
      hasPrev: false,
    });
  });

  it('narrows by search', async () => {
    const { controller } = await seeded();
    const page = await controller.tags({ search: 'slo' });
    expect(page.data).toEqual([{ tag: 'slow', count: 1 }]);
  });

  it('re-applies the page when a provider ignores the query', async () => {
    const { storage, controller } = await seeded();
    const all = await storage.tags();
    vi.spyOn(storage, 'tags').mockResolvedValue(all);
    const first = await controller.tags({ first: '1' });
    expect(first.data).toEqual([all[0]]);
    const second = await controller.tags({ first: '1', after: first.meta.nextCursor });
    expect(second.data).toEqual([all[1]]);
  });

  it('pages correctly when a provider honours offset but ignores limit', async () => {
    const { storage, controller } = await seeded();
    const all = await storage.tags();
    expect(all.length).toBeGreaterThan(3);
    vi.spyOn(storage, 'tags').mockImplementation(async (_prefix, query) =>
      all.slice(query?.offset ?? 0),
    );
    const first = await controller.tags({ first: '1' });
    expect(first.data).toEqual([all[0]]);
    const second = await controller.tags({ first: '1', after: first.meta.nextCursor });
    expect(second.data).toEqual([all[1]]);
    const third = await controller.tags({ first: '2', after: second.meta.nextCursor });
    expect(third.data).toEqual([all[2], all[3]]);
  });

  it.each([
    [{ prefix: 'user:' }, /filter\[tag\]\[startsWith\]/],
    [{ limit: '5' }, /"first"/],
    [{ offset: '5' }, /"after"/],
    [{ tag: 'x' }, /filter\[tag\]/],
    [{ page: '2' }, /"page"/],
    [{ after: 'not-a-cursor' }, /Malformed cursor/],
    [{ filter: { tag: 'x' } }, /operator "eq" is not supported/],
  ])('rejects %j with a 400', async (query, message) => {
    const { controller } = setup();
    await expect(controller.tags(query as Record<string, unknown>)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(message),
    });
  });
});

describe('TelescopeController profiles', () => {
  it('lists profiles as a cursor list that resumes after the cursor', async () => {
    const { storage, controller } = setup();
    await storage.store([
      entry({ id: 'p1', type: 'cpu_profile', createdAt: new Date(1000), content: { big: 1 } }),
      entry({ id: 'p2', type: 'cpu_profile', createdAt: new Date(2000), content: { big: 1 } }),
      entry({ id: 'r', type: 'request', createdAt: new Date(3000) }),
    ]);
    const first = await controller.profiles({ first: '1' });
    expect(first.data.map((e) => [e.id, e.content])).toEqual([['p2', null]]);
    expect(first.meta.hasNext).toBe(true);
    const second = await controller.profiles({ first: '1', after: first.meta.nextCursor });
    expect(second.data.map((e) => e.id)).toEqual(['p1']);
  });

  it('rejects limit and unknown params with a 400, but takes the console tenant', async () => {
    const { controller } = setup();
    await expect(controller.profiles({ limit: '5' })).rejects.toMatchObject({ status: 400 });
    await expect(controller.profiles({ next: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(controller.profiles({ tenant: 'acme' })).resolves.toMatchObject({ data: [] });
  });
});

describe('TelescopeController AI endpoints', () => {
  it('404s the metrics scrape while aiMetrics.prometheus is off', () => {
    const { controller } = setup();
    expect(() => controller.metrics()).toThrow(/metrics endpoint is off/);
  });

  it('summarizes the AI screen over a window', async () => {
    const { controller } = setup();
    const result = await controller.ai('1h');
    expect(result.spend.totalUsd).toBe(0);
    expect(result.coverage.legacyAgentLib).toBe(false);
  });

  it('takes the agent runs size as `size`, and rejects `limit`', async () => {
    const { controller } = setup();
    await expect(controller.ai('1h', undefined, undefined, '10')).resolves.toBeDefined();
    await expect(controller.ai('1h', undefined, undefined, 'x')).rejects.toMatchObject({
      status: 400,
    });
    await expect(controller.ai('1h', undefined, undefined, undefined, '10')).rejects.toMatchObject({
      status: 400,
    });
  });
});
