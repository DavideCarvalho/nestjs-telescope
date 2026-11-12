// packages/core/src/nest/telescope.module.tenancy.e2e.spec.ts
//
// The console's tenant scope over HTTP: `authorize` grants organizations, `?tenant=` picks one
// of them, and every read of the store is limited to it. Tenancy off: the console is unchanged.
import 'reflect-metadata';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { ForbiddenException, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelescopeAiOptions } from '../ai/diagnoser.js';
import type { TenantFilter } from '../context/tenancy.js';
import { type Entry, EntryType } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { type ConsoleAuthorizeResult, resolveConsoleAuthorize } from './console-authorize.js';
import { telescopeConsoleSearch } from './console-search.js';
import { DEV_TOOLS_SLOT, type TelescopeDevTool } from './dev-tools.js';
import { TelescopeModule } from './telescope.module.js';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';

const SLOT = Symbol.for('@dudousxd/nestjs-diagnostics:accessor');
const holder = globalThis as Record<symbol, unknown>;

/** A stand-in for `@dudousxd/nestjs-context`: the `x-tenant` header is the request's tenant. */
const requestTenant = new AsyncLocalStorage<{ tenant?: string }>();
let tenancyEnabled = true;
const accessor = {
  tenancy: () => ({ enabled: tenancyEnabled }),
  tenantFilter: (): TenantFilter => {
    const store = requestTenant.getStore();
    if (store === undefined) return { mode: 'system' };
    if (store.tenant === undefined) return { mode: 'tenantless' };
    return {
      mode: 'tenant',
      tenant: {
        id: store.tenant,
        kind: 'organization',
        source: 'app',
        slug: `${store.tenant}-slug`,
      },
    };
  },
};

function entry(id: string, tags: string[], type: string = EntryType.Request): Entry {
  return {
    id,
    batchId: `batch-${id}`,
    type,
    content: { method: 'GET', uri: `/${id}`, statusCode: 200 },
    tags,
    durationMs: 5,
    createdAt: new Date(),
    familyHash: null,
    traceId: null,
    spanId: null,
    sequence: 0,
    origin: 'http',
    instanceId: 'i1',
  };
}

let app: INestApplication | undefined;
let storage: InMemoryStorageProvider;

/** `x-grant` (JSON) is what `authorize` answers; `x-tenant` is the viewer's own tenant. */
async function boot(options: Partial<TelescopeModuleOptions> = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      TelescopeModule.forRoot({
        storage,
        mutations: true,
        authorize: (context: ExecutionContext): ConsoleAuthorizeResult => {
          const grant = context.switchToHttp().getRequest().headers['x-grant'];
          return grant ? (JSON.parse(grant) as ConsoleAuthorizeResult) : true;
        },
        ...options,
      }),
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.use((req: { headers: Record<string, string> }, _res: unknown, next: () => void) => {
    const tenant = req.headers['x-tenant'];
    requestTenant.run(tenant ? { tenant } : {}, next);
  });
  await app.init();
  return app;
}

async function ids(path: string, headers: Record<string, string> = {}): Promise<string[]> {
  const res = await request(app?.getHttpServer()).get(path).set(headers).expect(200);
  return (res.body.data as Entry[]).map((e) => e.id).sort();
}

beforeEach(async () => {
  tenancyEnabled = true;
  holder[SLOT] = { current: accessor };
  delete holder[DEV_TOOLS_SLOT];
  storage = new InMemoryStorageProvider();
  await storage.store([
    entry('a1', ['tenant:A', 'user:User#1']),
    entry('a2', ['tenant:A'], EntryType.Exception),
    entry('b1', ['tenant:B', 'user:User#2']),
    entry('n1', []),
  ]);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  delete holder[SLOT];
  delete holder[DEV_TOOLS_SLOT];
  vi.restoreAllMocks();
});

describe('tenancy off', () => {
  it('shows every entry and ignores ?tenant=', async () => {
    tenancyEnabled = false;
    await boot();
    expect(await ids('/telescope/api/entries', { 'x-tenant': 'A' })).toEqual([
      'a1',
      'a2',
      'b1',
      'n1',
    ]);
    expect(await ids('/telescope/api/entries?tenant=B')).toEqual(['a1', 'a2', 'b1', 'n1']);
    const res = await request(app?.getHttpServer()).get('/telescope/api/tenancy').expect(200);
    expect(res.body).toEqual({ enabled: false });
  });

  it('`tenancy: false` keeps telescope out even when the context turns it on', async () => {
    await boot({ tenancy: false });
    expect(await ids('/telescope/api/entries', { 'x-tenant': 'A' })).toEqual([
      'a1',
      'a2',
      'b1',
      'n1',
    ]);
  });

  it('with no context at all, the console is unchanged', async () => {
    delete holder[SLOT];
    await boot();
    expect(await ids('/telescope/api/entries')).toEqual(['a1', 'a2', 'b1', 'n1']);
  });
});

describe('scope from authorize', () => {
  it('no `tenants`: the viewer sees their own organization only', async () => {
    await boot();
    const headers = { 'x-tenant': 'A' };
    expect(await ids('/telescope/api/entries', headers)).toEqual(['a1', 'a2']);
    expect(await ids('/telescope/api/entries?type=exception', headers)).toEqual(['a2']);
    const other = await request(app?.getHttpServer())
      .get('/telescope/api/entries/b1')
      .set(headers)
      .expect(200);
    expect(other.body).toEqual({});
    const tags = await request(app?.getHttpServer())
      .get('/telescope/api/tags?prefix=user:')
      .set(headers)
      .expect(200);
    expect(tags.body).toEqual([{ tag: 'user:User#1', count: 1 }]);
    const info = await request(app?.getHttpServer())
      .get('/telescope/api/tenancy')
      .set(headers)
      .expect(200);
    expect(info.body).toEqual({
      enabled: true,
      tenants: ['A'],
      selected: 'A',
      options: [{ id: 'A', label: 'A-slug' }],
    });
  });

  it('no tenant on the request: an empty console', async () => {
    await boot();
    expect(await ids('/telescope/api/entries')).toEqual([]);
    const info = await request(app?.getHttpServer()).get('/telescope/api/tenancy').expect(200);
    expect(info.body).toEqual({ enabled: true, tenants: [], selected: null, options: [] });
  });

  it('a list: the first by default, any of them by ?tenant=', async () => {
    await boot();
    const headers = { 'x-grant': JSON.stringify({ allowed: true, tenants: ['A', 'B'] }) };
    expect(await ids('/telescope/api/entries', headers)).toEqual(['a1', 'a2']);
    expect(await ids('/telescope/api/entries?tenant=B', headers)).toEqual(['b1']);
  });

  it('a forged ?tenant= outside the scope answers empty, and is logged', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await boot();
    expect(await ids('/telescope/api/entries?tenant=B', { 'x-tenant': 'A' })).toEqual([]);
    const headers = { 'x-grant': JSON.stringify({ allowed: true, tenants: ['A'] }) };
    expect(await ids('/telescope/api/entries?tenant=C', headers)).toEqual([]);
    const info = await request(app?.getHttpServer())
      .get('/telescope/api/tenancy?tenant=C')
      .set(headers)
      .expect(200);
    expect(info.body.selected).toBeNull();
    const forged = warn.mock.calls.map(([message]) => String(message));
    expect(forged.some((m) => m.includes('"B" is outside'))).toBe(true);
    expect(forged.some((m) => m.includes('"C" is outside'))).toBe(true);
  });

  it("'*': every organization and untagged entries; ?tenant= narrows to one", async () => {
    await boot();
    const headers = { 'x-grant': JSON.stringify({ allowed: true, tenants: '*' }) };
    expect(await ids('/telescope/api/entries', headers)).toEqual(['a1', 'a2', 'b1', 'n1']);
    expect(await ids('/telescope/api/entries?tenant=B', headers)).toEqual(['b1']);
    const info = await request(app?.getHttpServer())
      .get('/telescope/api/tenancy?tenant=B')
      .set(headers)
      .expect(200);
    expect(info.body.selected).toBe('B');
    expect(info.body.options.map((o: { id: string }) => o.id).sort()).toEqual(['A', 'B']);
  });

  it('nullRows: shared adds untagged entries to an organization', async () => {
    await boot({ tenancy: { nullRows: 'shared' } });
    expect(await ids('/telescope/api/entries', { 'x-tenant': 'A' })).toEqual(['a1', 'a2', 'n1']);
  });

  it('one organization cannot clear, prune or read live queues', async () => {
    await boot({ prune: { after: '1h' } });
    const headers = { 'x-tenant': 'A' };
    await request(app?.getHttpServer()).delete('/telescope/api/entries').set(headers).expect(403);
    await request(app?.getHttpServer())
      .post('/telescope/api/retention/prune')
      .set(headers)
      .expect(403);
    const live = await request(app?.getHttpServer())
      .get('/telescope/api/queues/live')
      .set(headers)
      .expect(200);
    expect(live.body.queues).toEqual([]);
    expect(
      await ids('/telescope/api/entries', { 'x-grant': '{"allowed":true,"tenants":"*"}' }),
    ).toHaveLength(4);
  });
});

describe('AI diagnosis', () => {
  /** A diagnoser that answers with what it was given: a leak shows up in the markdown. */
  const seen: string[] = [];
  const ai: TelescopeAiOptions = {
    diagnoser: {
      diagnose: async (context) => {
        const markdown = `${context.message} | ${context.recentQueries.join(',')}`;
        seen.push(markdown);
        return markdown;
      },
    },
  };

  function exception(id: string, tenant: string, message: string, batchId: string): Entry {
    return {
      ...entry(id, [`tenant:${tenant}`], EntryType.Exception),
      batchId,
      familyHash: 'family-1',
      content: { class: 'Error', message, stack: 'Error\n  at x' },
    };
  }

  function query(id: string, tenant: string, sql: string, batchId: string): Entry {
    return { ...entry(id, [`tenant:${tenant}`], EntryType.Query), batchId, content: { sql } };
  }

  beforeEach(async () => {
    seen.length = 0;
    await storage.store([
      exception('xa', 'A', 'secret of A', 'batch-xa'),
      query('qa', 'A', 'select a_secret', 'batch-xa'),
      exception('xb', 'B', 'trouble of B', 'batch-xb'),
      // A stray entry of A in B's batch never reaches B's diagnosis.
      query('qa2', 'A', 'select a_stray', 'batch-xb'),
    ]);
  });

  const diagnose = (id: string, headers: Record<string, string>) =>
    request(app?.getHttpServer()).post(`/telescope/api/exceptions/${id}/diagnose`).set(headers);
  const cached = (id: string, headers: Record<string, string>) =>
    request(app?.getHttpServer()).get(`/telescope/api/exceptions/${id}/diagnosis`).set(headers);

  it("tenant B never gets a diagnosis built from tenant A's occurrences", async () => {
    await boot({ ai });
    const a = await diagnose('xa', { 'x-tenant': 'A' }).expect(200);
    expect(a.body).toEqual({ markdown: 'secret of A | select a_secret', cached: false });

    // Same family, other organization: nothing cached for B, and B's own run sees only B.
    await cached('xb', { 'x-tenant': 'B' }).expect(204);
    await diagnose('xa', { 'x-tenant': 'B' }).expect(404);
    const b = await diagnose('xb', { 'x-tenant': 'B' }).expect(200);
    expect(b.body).toEqual({ markdown: 'trouble of B | ', cached: false });
    expect((await cached('xb', { 'x-tenant': 'B' }).expect(200)).body.markdown).not.toContain('A');
    expect((await diagnose('xb', { 'x-tenant': 'B' }).expect(200)).body.cached).toBe(true);
    expect(seen).toEqual(['secret of A | select a_secret', 'trouble of B | ']);
  });

  it("'*' viewers read the unscoped diagnosis; an organization never reads theirs", async () => {
    await boot({ ai });
    const all = { 'x-grant': JSON.stringify({ allowed: true, tenants: '*' }) };
    await diagnose('xa', all).expect(200);
    expect((await cached('xb', all).expect(200)).body.markdown).toBe(
      'secret of A | select a_secret',
    );
    await cached('xb', { 'x-tenant': 'B' }).expect(204);
    await cached('xa', { 'x-tenant': 'A' }).expect(204);
  });

  it('tenancy off: one diagnosis per family, as before', async () => {
    tenancyEnabled = false;
    await boot({ ai });
    await diagnose('xa', { 'x-tenant': 'A' }).expect(200);
    const b = await cached('xb', { 'x-tenant': 'B' }).expect(200);
    expect(b.body).toEqual({ markdown: 'secret of A | select a_secret', cached: true });
  });
});

describe('dev tools', () => {
  function devTool(name: string): TelescopeDevTool & {
    authorize(context: ExecutionContext): Promise<unknown>;
  } {
    const lib = (
      holder[DEV_TOOLS_SLOT] as {
        libs: {
          lib: string;
          authorize(context: ExecutionContext): Promise<unknown>;
          tools: TelescopeDevTool[];
        }[];
      }
    ).libs.find((l) => l.lib === 'telescope');
    const found = lib?.tools.find((t) => t.name === name);
    if (!lib || !found) throw new Error(`no tool ${name}`);
    return { ...found, authorize: lib.authorize };
  }

  function ctx(headers: Record<string, string>): ExecutionContext {
    const req = { headers };
    return {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
      getType: () => 'http',
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
  }

  async function listed(tenant: string | undefined, grant?: string): Promise<string[]> {
    const list = devTool('telescope_list_entries');
    const context = ctx(grant ? { 'x-grant': grant } : {});
    return requestTenant.run(tenant ? { tenant } : {}, async () => {
      await list.authorize(context);
      const result = (await list.run(
        {},
        { context, caller: { id: 'x', via: 'open' }, limits: { maxRows: 50, maxBytes: 1e6 } },
      )) as { items: { id: string }[] };
      return result.items.map((i) => i.id).sort();
    });
  }

  it('read only the caller’s organization, by the same rule', async () => {
    await boot();
    expect(await listed('A')).toEqual(['a1', 'a2']);
    expect(await listed(undefined)).toEqual([]);
    expect(await listed(undefined, '{"allowed":true,"tenants":"*"}')).toEqual([
      'a1',
      'a2',
      'b1',
      'n1',
    ]);
  });

  it('tenancy off: every entry', async () => {
    tenancyEnabled = false;
    await boot();
    expect(await listed('A')).toEqual(['a1', 'a2', 'b1', 'n1']);
  });
});

describe('the full contract (context >= 2.1)', () => {
  it('an organization sees the entries of every level below it (one tag per level)', async () => {
    await storage.store([entry('u1', ['tenant:C', 'tenant:U']), entry('c1', ['tenant:C'])]);
    await boot();
    const clinic = { 'x-grant': JSON.stringify({ allowed: true, tenants: ['C'] }) };
    expect(await ids('/telescope/api/entries', clinic)).toEqual(['c1', 'u1']);
    const unit = { 'x-grant': JSON.stringify({ allowed: true, tenants: ['U'] }) };
    expect(await ids('/telescope/api/entries', unit)).toEqual(['u1']);
  });

  it('`required`: a viewer with no tenant and no grant gets the context’s 403; a grant needs none', async () => {
    const required = {
      ...accessor,
      tenancy: () => ({ enabled: true, required: true }),
      tenantFilter: (options?: { required?: boolean }): TenantFilter => {
        const filter = accessor.tenantFilter();
        if (filter.mode === 'tenantless' && options?.required !== false) {
          throw Object.assign(
            new ForbiddenException({ code: 'E_TENANT_REQUIRED', message: 'A tenant is required.' }),
            { code: 'E_TENANT_REQUIRED' },
          );
        }
        return filter;
      },
    };
    holder[SLOT] = { current: required };
    await boot();
    await request(app?.getHttpServer()).get('/telescope/api/entries').expect(403);
    const everyone = { 'x-grant': JSON.stringify({ allowed: true, tenants: '*' }) };
    expect(await ids('/telescope/api/entries', everyone)).toEqual(['a1', 'a2', 'b1', 'n1']);
    expect(await ids('/telescope/api/entries', { 'x-tenant': 'A' })).toEqual(['a1', 'a2']);
  });

  it('labels the organization picker with the context’s tenantLabels', async () => {
    const seen: unknown[] = [];
    holder[SLOT] = {
      current: {
        ...accessor,
        tenantLabels: async (tenants: Array<{ id: string; kind: string; slug?: string }>) => {
          seen.push(tenants);
          return Object.fromEntries(tenants.map((t) => [t.id, `Org ${t.id}`]));
        },
      },
    };
    await boot({ tenancy: { kinds: ['clinic'] } });
    const headers = {
      'x-tenant': 'A',
      'x-grant': JSON.stringify({ allowed: true, tenants: ['A', 'B'] }),
    };
    const info = await request(app?.getHttpServer())
      .get('/telescope/api/tenancy?search=org b')
      .set(headers)
      .expect(200);
    expect(info.body.options).toEqual([{ id: 'B', label: 'Org B' }]);
    expect(seen[0]).toEqual([
      { id: 'A', kind: 'organization', slug: 'A-slug' },
      { id: 'B', kind: 'clinic' },
    ]);
  });

  it('finds an organization by label deep in a long granted list', async () => {
    const calls: number[] = [];
    holder[SLOT] = {
      current: {
        ...accessor,
        tenantLabels: async (tenants: Array<{ id: string }>) => {
          calls.push(tenants.length);
          return Object.fromEntries(tenants.map((t) => [t.id, `Clinic number ${t.id.slice(1)}`]));
        },
      },
    };
    await boot();
    const ids = Array.from({ length: 450 }, (_, i) => `t${i}`);
    const headers = { 'x-grant': JSON.stringify({ allowed: true, tenants: ids }) };
    const info = await request(app?.getHttpServer())
      .get('/telescope/api/tenancy?search=number 420')
      .set(headers)
      .expect(200);
    expect(info.body.options).toEqual([{ id: 't420', label: 'Clinic number 420' }]);
    expect(calls).toEqual([200, 200, 50]);
    const first = await request(app?.getHttpServer())
      .get('/telescope/api/tenancy')
      .set(headers)
      .expect(200);
    expect(first.body.options).toHaveLength(50);
  });

  it('a labeler that throws falls back to the slug, then the id', async () => {
    holder[SLOT] = {
      current: {
        ...accessor,
        tenantLabels: async () => {
          throw new Error('down');
        },
      },
    };
    await boot();
    const headers = {
      'x-tenant': 'A',
      'x-grant': JSON.stringify({ allowed: true, tenants: ['A', 'B'] }),
    };
    const info = await request(app?.getHttpServer())
      .get('/telescope/api/tenancy')
      .set(headers)
      .expect(200);
    expect(info.body.options).toEqual([
      { id: 'A', label: 'A-slug' },
      { id: 'B', label: 'B' },
    ]);
  });
});

describe('the switcher search (telescopeConsoleSearch)', () => {
  function viewer(grant: ConsoleAuthorizeResult): ExecutionContext {
    const req = { headers: { 'x-grant': JSON.stringify(grant) } };
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
  }

  async function searcher() {
    const started = await boot();
    const moduleRef = started.get(ModuleRef);
    const options = started.get(TELESCOPE_OPTIONS) as TelescopeModuleOptions;
    const decide = await resolveConsoleAuthorize(options.authorize, moduleRef, {
      warnIfMissing: false,
    });
    return telescopeConsoleSearch(moduleRef, decide, '/telescope');
  }

  it('finds an entry by id and tags, only inside the organizations authorize grants', async () => {
    const search = await searcher();
    const onlyA = viewer({ allowed: true, tenants: ['A'] });
    expect(await search(onlyA, 'a1', 5)).toEqual([
      { title: 'request a1', subtitle: 'GET /a1 → 200', href: '/telescope#/entries/view/a1' },
    ]);
    expect(await search(onlyA, 'b1', 5)).toEqual([]);
    expect((await search(onlyA, 'User', 5)).map((hit) => hit.title)).toEqual(['user:User#1']);
    expect((await search(onlyA, 'User', 5))[0]?.href).toBe(
      '/telescope#/entries?tag=user%3AUser%231',
    );
    const everyone = viewer({ allowed: true, tenants: '*' });
    expect((await search(everyone, 'b1', 5))[0]?.href).toBe('/telescope#/entries/view/b1');
    expect(await search(viewer({ allowed: false }), 'a1', 5)).toEqual([]);
  });

  it('keeps to the limit', async () => {
    const search = await searcher();
    expect(await search(viewer({ allowed: true, tenants: '*' }), 'User', 1)).toHaveLength(1);
  });
});
