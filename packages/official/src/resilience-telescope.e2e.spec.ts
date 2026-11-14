// The Resilience page against the REAL @nestjs/resilience: a preset's breaker opens, the watcher
// records it, the page's providers show it (live and from history), and the reset closes it,
// from the console and from the dev tools, with an audit trail.
import 'reflect-metadata';
import {
  DEV_TOOLS_SLOT,
  type Entry,
  InMemoryStorageProvider,
  type TelescopeDevTool,
  TelescopeModule,
  TelescopeService,
} from '@dudousxd/nestjs-telescope';
import { type INestApplication, Logger } from '@nestjs/common';
import { ResilienceModule, ResilienceService } from '@nestjs/resilience';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resilienceTelescopeExtension } from './resilience-telescope.js';
import { NestResilienceWatcher } from './resilience.watcher.js';

const holder = globalThis as Record<symbol, unknown>;
const devTool = (name: string): TelescopeDevTool => {
  const libs = (
    holder[DEV_TOOLS_SLOT] as { libs: Array<{ lib: string; tools: TelescopeDevTool[] }> }
  ).libs;
  const found = libs.find((lib) => lib.lib === 'telescope')?.tools.find((t) => t.name === name);
  if (!found) throw new Error(`no dev tool ${name}`);
  return found;
};

describe('resilienceTelescopeExtension (real @nestjs/resilience)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageProvider;
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

  const data = async (provider: string, query = '') =>
    (
      await request(app.getHttpServer())
        .get(`/telescope/api/ext/resilience/data/${provider}${query}`)
        .expect(200)
    ).body;

  const flush = async () => {
    await app.get(TelescopeService).flush();
    // Past the providers' shared-read window, so the next read sees the new entries.
    vi.advanceTimersByTime(5_000);
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    delete holder[DEV_TOOLS_SLOT];
    storage = new InMemoryStorageProvider();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ResilienceModule.forRoot({
          presets: {
            payments: { circuitBreaker: { minimumCalls: 1, openDuration: '1m' } },
            reports: { bulkhead: { maxConcurrent: 2, maxQueue: 0 } },
          },
        }),
        TelescopeModule.forRoot({
          storage,
          mutations: true,
          watchers: [new NestResilienceWatcher()],
          extensions: [resilienceTelescopeExtension()],
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    const resilience = app.get(ResilienceService);
    resilience.preset('reports');
    const payments = resilience.preset('payments');
    await payments.execute(() => Promise.reject(new Error('down'))).catch(() => undefined);
    await payments.execute(() => 'never').catch(() => undefined);
    await flush();
  });

  afterAll(async () => {
    await app?.close();
    vi.useRealTimers();
    log.mockRestore();
  });

  it('declares the page, its providers, the reset action and the dev tools', async () => {
    const meta = (await request(app.getHttpServer()).get('/telescope/api/meta').expect(200)).body;
    const page = meta.dashboards.find((d: { id: string }) => d.id === 'resilience.overview');
    expect(page.label).toBe('Resilience');
    expect(page.sections.map((s: { title: string }) => s.title)).toEqual([
      'Now',
      'Circuits',
      'Activity',
      'Bulkheads and rate limiters',
      'Recent transitions',
    ]);
    expect(meta.actions).toEqual([
      expect.objectContaining({ ext: 'resilience', name: 'reset-circuit', destructive: true }),
    ]);
    expect(devTool('telescope_resilience_circuits').kind).toBe('read');
    expect(devTool('telescope_resilience_reset_circuit').kind).toBe('action');
  });

  it('shows the open circuit live, with its history', async () => {
    expect(await data('resilience.stats', '?metric=open')).toEqual({ value: 1 });
    expect((await data('resilience.stats', '?metric=short-circuited')).value).toBe(1);
    expect((await data('resilience.stats', '?metric=opened')).value).toBe(1);
    const circuits = await data('resilience.circuits', '?page=1&size=50');
    expect(circuits.meta.total).toBe(1);
    expect(circuits.data[0]).toMatchObject({
      name: 'payments',
      status: 'open',
      calls: 1,
      failures: 1,
      failureRate: '100%',
      threshold: '50%',
      opens: 1,
      shortCircuited: 1,
      scope: 'live',
    });
    expect(circuits.data[0].probesAt).not.toBe('');
  });

  it('lists the bulkheads, the events over time, the noisiest policies and the transitions', async () => {
    const bulkheads = await data('resilience.bulkheads');
    expect(bulkheads.rows).toEqual([
      expect.objectContaining({ name: 'reports', active: 0, maxConcurrent: 2, scope: 'live' }),
    ]);
    const series = await data('resilience.events-over-time');
    expect(series.rows).toHaveLength(12);
    const totals = series.rows.reduce(
      (sum: Record<string, number>, row: Record<string, number>) => {
        for (const [key, value] of Object.entries(row)) {
          if (typeof value === 'number') sum[key] = (sum[key] ?? 0) + value;
        }
        return sum;
      },
      {},
    );
    expect(totals['circuit-open']).toBe(1);
    expect(totals['circuit-rejected']).toBe(1);
    expect((await data('resilience.noisy-policies')).items).toEqual([
      { label: 'payments', value: 1, id: 'payments' },
    ]);
    const transitions = await data('resilience.transitions');
    expect(transitions.rows).toEqual([
      expect.objectContaining({ policy: 'payments', from: 'closed', to: 'open' }),
    ]);
  });

  it('sorts only by a sortable column', async () => {
    const sorted = await data('resilience.circuits', '?page=1&size=50&sort=-name');
    expect(sorted.data.map((row: { name: string }) => row.name)).toEqual(['payments']);
    await request(app.getHttpServer())
      .get('/telescope/api/ext/resilience/data/resilience.circuits?sort=-constructor')
      .expect(400);
  });

  it('filters every provider by the drilled-down policy', async () => {
    expect((await data('resilience.circuits', '?policy=reports')).total).toBe(0);
    expect((await data('resilience.stats', '?metric=opened&policy=reports')).value).toBe(0);
  });

  it('resets the circuit from the console after a confirmation, and records who did it', async () => {
    await request(app.getHttpServer())
      .post('/telescope/api/ext/resilience/actions/reset-circuit')
      .send({ input: { name: 'payments' } })
      .expect(400);
    await request(app.getHttpServer())
      .post('/telescope/api/ext/resilience/actions/reset-circuit')
      .send({ confirmed: true, input: { name: 'nope' } })
      .expect(404);
    const res = await request(app.getHttpServer())
      .post('/telescope/api/ext/resilience/actions/reset-circuit')
      .send({ confirmed: true, input: { name: 'payments' } })
      .expect(200);
    expect(res.body.result).toEqual({ name: 'payments', from: 'open', state: 'closed' });
    expect(app.get(ResilienceService).circuitBreaker('payments').state).toBe('closed');
    expect(
      log.mock.calls.some((c) =>
        String(c[0]).startsWith(
          'extension action resilience.reset-circuit ok by anonymous via console',
        ),
      ),
    ).toBe(true);

    await flush();
    expect(await data('resilience.stats', '?metric=open')).toEqual({ value: 0 });
    const transitions = (await data('resilience.transitions')).rows;
    expect(transitions[0]).toMatchObject({
      policy: 'payments',
      to: 'closed (reset)',
      by: 'anonymous',
    });
    const page = await storage.get({ type: 'resilience', tag: 'resilience:circuit-reset' });
    expect((page.data[0] as Entry).content).toMatchObject({ by: 'anonymous', via: 'console' });
  });

  it('lists and resets circuits over the dev tools', async () => {
    app.get(ResilienceService).circuitBreaker('payments').trip();
    const call = {
      context: {} as never,
      caller: { id: 'token:abc', via: 'token' as const },
      limits: { maxRows: 100, maxBytes: 100_000 },
    };
    const listed = (await devTool('telescope_resilience_circuits').run(
      { status: 'open' },
      call,
    )) as {
      items: Array<{ name: string; status: string }>;
      bulkheads: Array<{ name: string }>;
    };
    expect(listed.items.map((row) => [row.name, row.status])).toEqual([['payments', 'open']]);
    expect(listed.bulkheads.map((b) => b.name)).toEqual(['reports']);

    await expect(
      devTool('telescope_resilience_reset_circuit').run({ name: 'payments' }, call),
    ).resolves.toEqual({ name: 'payments', from: 'open', state: 'closed' });
    expect(
      log.mock.calls.some((c) =>
        String(c[0]).startsWith(
          'extension action resilience.telescope_resilience_reset_circuit ok by token:abc via dev-tools',
        ),
      ),
    ).toBe(true);
  });

  it('refuses the reset while mutations are off', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ResilienceModule.forRoot({}),
        TelescopeModule.forRoot({
          storage: new InMemoryStorageProvider(),
          devTools: false,
          extensions: [resilienceTelescopeExtension()],
        }),
      ],
    }).compile();
    const other = moduleRef.createNestApplication({ logger: false });
    await other.init();
    try {
      await request(other.getHttpServer())
        .post('/telescope/api/ext/resilience/actions/reset-circuit')
        .send({ confirmed: true, input: { name: 'payments' } })
        .expect(403);
    } finally {
      await other.close();
    }
  });
});

describe('resilienceTelescopeExtension({ reset: false })', () => {
  it('has no reset action, button or tool', () => {
    const ext = resilienceTelescopeExtension({ reset: false });
    const ctx = {} as never;
    expect(ext.actions?.(ctx)).toEqual([]);
    expect(ext.devTools?.(ctx).map((t) => t.name)).toEqual(['resilience_circuits']);
    const circuits = ext
      .dashboards?.(ctx)[0]
      ?.sections?.flatMap((s) => s.panels)
      .find((p) => p.kind === 'table' && p.data.provider === 'resilience.circuits');
    expect(JSON.stringify(circuits)).not.toContain('reset-circuit');
  });
});
