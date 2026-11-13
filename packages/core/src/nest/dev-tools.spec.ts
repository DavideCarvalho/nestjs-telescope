import 'reflect-metadata';
import { type ExecutionContext, type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryType } from '../entry/entry.js';
import type { Entry } from '../entry/entry.js';
import type { PulseService } from '../pulse/pulse.service.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { authorizeByToken } from './console-authorize.js';
import {
  DEV_TOOLS_SLOT,
  type TelescopeDevTool,
  extensionDevTools,
  telescopeDevTools,
} from './dev-tools.js';
import { TelescopeMcpServer } from './telescope-mcp.server.js';
import { TelescopeModule } from './telescope.module.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import type { TelescopeService } from './telescope.service.js';

const TOKEN = 'console-token-123';
const holder = globalThis as Record<symbol, unknown>;

interface Lib {
  lib: string;
  title: string;
  authorize(context: ExecutionContext): Promise<{ allowed: boolean; reason?: string }>;
  tools: TelescopeDevTool[];
}

const libs = () => (holder[DEV_TOOLS_SLOT] as { libs: Lib[] } | undefined)?.libs ?? [];
const telescope = () => libs().find((lib) => lib.lib === 'telescope');

function tool(name: string): TelescopeDevTool {
  const found = telescope()?.tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function ctx(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => ({}) }),
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function entry(overrides: Partial<Entry> & { id: string }): Entry {
  return {
    batchId: 'b1',
    type: EntryType.Request,
    content: { method: 'GET', uri: '/x', statusCode: 200 },
    tags: [],
    durationMs: 5,
    createdAt: new Date(),
    familyHash: null,
    traceId: null,
    spanId: null,
    sequence: 0,
    origin: 'http',
    instanceId: 'i1',
    ...overrides,
  };
}

let app: INestApplication | undefined;
let storage: InMemoryStorageProvider;

async function boot(options: TelescopeModuleOptions) {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot({ storage, ...options })],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

beforeEach(() => {
  delete holder[DEV_TOOLS_SLOT];
  storage = new InMemoryStorageProvider();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('telescope dev tools registration', () => {
  it('registers the tools while the routes are mounted, and removes them on close', async () => {
    await boot({ authorize: authorizeByToken({ token: TOKEN }) });
    expect(telescope()?.title).toBe('Telescope');
    expect(telescope()?.tools.map((t) => t.name)).toEqual([
      'telescope_list_entries',
      'telescope_get_entry',
      'telescope_get_trace',
      'telescope_get_waterfall',
      'telescope_get_health',
      'telescope_diagnose_exception',
    ]);
    expect(telescope()?.tools.every((t) => t.kind === 'read')).toBe(true);
    await app?.close();
    app = undefined;
    expect(telescope()).toBeUndefined();
  });

  it('is gated by the console’s authorize, not mcpAuthorize', async () => {
    await boot({
      authorize: authorizeByToken({ token: TOKEN }),
      mcpAuthorize: () => true,
    });
    expect(await telescope()?.authorize(ctx({ authorization: `Bearer ${TOKEN}` }))).toEqual({
      allowed: true,
    });
    expect(await telescope()?.authorize(ctx({}))).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  it('a throwing authorize is forbidden', async () => {
    await boot({
      authorize: () => {
        throw new Error('boom');
      },
    });
    expect(await telescope()?.authorize(ctx({}))).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('is off with routes: false unless devTools: true, and off with devTools: false', async () => {
    await boot({ routes: false, authorize: () => true });
    expect(telescope()).toBeUndefined();
    await app?.close();
    await boot({ routes: false, devTools: true, authorize: () => true });
    expect(telescope()).toBeDefined();
    await app?.close();
    await boot({ devTools: false, authorize: () => true });
    expect(telescope()).toBeUndefined();
  });

  it('leaves the standalone MCP endpoint as it was', async () => {
    const target = await boot({ mcp: true, authorize: () => true });
    const res = await request(target.getHttpServer())
      .post('/telescope/api/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(200);
    expect(res.body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'list_entries',
      'get_entry',
      'get_batch',
      'get_stats',
      'diagnose_exception',
    ]);
    const call = await request(target.getHttpServer())
      .post('/telescope/api/mcp')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_trace', arguments: { traceId: 't' } },
      })
      .expect(200);
    expect(call.body.error.message).toBe('Unknown tool: get_trace');
  });
});

describe('telescope dev tools', () => {
  beforeEach(async () => {
    await storage.store([
      entry({ id: 'e1', traceId: 't1', createdAt: new Date(Date.now() - 2000) }),
      entry({
        id: 'e2',
        type: EntryType.Query,
        content: { sql: 'select 1' },
        traceId: 't1',
        sequence: 1,
        createdAt: new Date(Date.now() - 1000),
      }),
      entry({
        id: 'x1',
        batchId: 'b2',
        type: EntryType.Exception,
        content: { class: 'Error', message: 'nope' },
      }),
    ]);
    await boot({ authorize: () => true });
  });

  it('lists entries as { items, next }, paging with the cursor', async () => {
    const first = (await tool('telescope_list_entries').run({ limit: 2 })) as {
      items: Array<{ id: string; summary: string }>;
      next: string | null;
    };
    expect(first.items.map((e) => e.id)).toEqual(['x1', 'e2']);
    expect(first.next).toEqual(expect.any(String));
    const second = (await tool('telescope_list_entries').run({
      limit: 2,
      cursor: first.next,
    })) as { items: Array<{ id: string }>; next: string | null };
    expect(second.items.map((e) => e.id)).toEqual(['e1']);
    expect(second.next).toBeNull();
  });

  it('caps a page at the endpoint’s maxRows', async () => {
    const page = (await tool('telescope_list_entries').run(
      { limit: 100 },
      {
        context: ctx({}),
        caller: { id: 'dev-open', via: 'open' },
        limits: { maxRows: 1, maxBytes: 1024 },
      },
    )) as { items: unknown[] };
    expect(page.items).toHaveLength(1);
  });

  it('gets an entry with its batch, a trace and its waterfall', async () => {
    const got = (await tool('telescope_get_entry').run({ id: 'e1' })) as {
      entry: { id: string };
      batch: Array<{ id: string }>;
    };
    expect(got.entry.id).toBe('e1');
    expect(got.batch.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
    const trace = (await tool('telescope_get_trace').run({ traceId: 't1' })) as {
      entries: Array<{ id: string }>;
    };
    expect(trace.entries.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
    const waterfall = (await tool('telescope_get_waterfall').run({ traceId: 't1' })) as {
      spans: unknown[];
      totalDurationMs: number;
    };
    expect(waterfall.spans.length).toBeGreaterThan(0);
    expect(waterfall.totalDurationMs).toEqual(expect.any(Number));
  });

  it('answers an unknown id with a "not found" error', async () => {
    await expect(tool('telescope_get_entry').run({ id: 'nope' })).rejects.toThrow(/not found/);
    await expect(tool('telescope_get_trace').run({ traceId: 'nope' })).rejects.toThrow(/not found/);
    await expect(tool('telescope_get_waterfall').run({ traceId: 'nope' })).rejects.toThrow(
      /not found/,
    );
  });

  it('answers the health over a window', async () => {
    const health = await tool('telescope_get_health').run({ sinceMinutes: 5 });
    expect(health).toEqual(expect.any(Object));
  });

  it('lists diagnose_exception only when a diagnosis coordinator exists', async () => {
    expect(await tool('telescope_diagnose_exception').available?.()).toBe(false);
    const server = app?.get(TelescopeMcpServer);
    expect(server?.canDiagnose()).toBe(false);
  });
});

describe('telescope_diagnose_exception with a coordinator', () => {
  it('diagnoses an exception entry, and a missing one is "not found"', async () => {
    await storage.store([
      entry({
        id: 'x1',
        type: EntryType.Exception,
        content: { class: 'Error', message: 'nope' },
      }),
    ]);
    const service = {
      diagnosisCoordinator: { diagnose: async () => ({ markdown: '## Cause' }) },
    } as unknown as TelescopeService;
    const server = new TelescopeMcpServer(storage, service, {} as PulseService);
    const diagnose = telescopeDevTools(server).find(
      (t) => t.name === 'telescope_diagnose_exception',
    );
    expect(await diagnose?.available?.()).toBe(true);
    expect(await diagnose?.run({ id: 'x1' })).toBe('## Cause');
    await expect(diagnose?.run({ id: 'nope' })).rejects.toThrow('Exception entry not found.');
  });
});

describe('extension dev tools', () => {
  const runs: Array<{ name: string; input: Record<string, unknown> }> = [];
  const extension = {
    name: 'demo',
    devTools: (): TelescopeDevTool[] => [
      {
        name: 'demo_list',
        kind: 'read',
        description: 'list',
        input: { type: 'object', properties: {} },
        run: async (input) => {
          runs.push({ name: 'demo_list', input });
          return { items: [] };
        },
      },
      {
        name: 'demo_reset',
        kind: 'action',
        destructive: true,
        description: 'reset',
        input: { type: 'object', properties: { name: { type: 'string' } } },
        run: async (input) => {
          runs.push({ name: 'demo_reset', input });
          if (input.name === 'boom') throw new Error('kaboom');
          return { ok: true };
        },
      },
    ],
  };
  const call = {
    context: ctx({}),
    caller: { id: 'token:abc', via: 'token' as const },
    limits: { maxRows: 100, maxBytes: 100_000 },
  };

  afterEach(() => {
    runs.length = 0;
    vi.restoreAllMocks();
  });

  it('serves extension tools with telescope’s, and audits each action run', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await boot({
      authorize: authorizeByToken({ token: TOKEN }),
      extensions: [extension],
      mutations: true,
    });
    const names = telescope()?.tools.map((t) => t.name) ?? [];
    expect(names).toContain('telescope_list_entries');
    expect(names.slice(-2)).toEqual(['telescope_demo_list', 'telescope_demo_reset']);

    await tool('telescope_demo_list').run({}, call);
    expect(log.mock.calls.some((c) => String(c[0]).includes('demo_list'))).toBe(false);

    await expect(tool('telescope_demo_reset').run({ name: 'stripe' }, call)).resolves.toEqual({
      ok: true,
    });
    await expect(tool('telescope_demo_reset').run({ name: 'boom' }, call)).rejects.toThrow(
      'kaboom',
    );
    const lines = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('demo_reset'));
    expect(lines).toEqual([
      'extension action demo.telescope_demo_reset ok by token:abc via dev-tools input={"name":"stripe"}',
      'extension action demo.telescope_demo_reset failed by token:abc via dev-tools input={"name":"boom"}',
    ]);
  });

  it('leaves action tools out while mutations are off', async () => {
    await boot({ authorize: authorizeByToken({ token: TOKEN }), extensions: [extension] });
    const names = telescope()?.tools.map((t) => t.name) ?? [];
    expect(names).toContain('telescope_demo_list');
    expect(names).not.toContain('telescope_demo_reset');
  });

  it('leaves out a tool the dev MCP endpoint would refuse, keeping telescope’s', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const bad = (name: string, extra: Partial<TelescopeDevTool> = {}): TelescopeDevTool => ({
      ...extension.devTools()[0]!,
      name,
      ...extra,
    });
    await boot({
      authorize: authorizeByToken({ token: TOKEN }),
      extensions: [
        extension,
        {
          name: 'broken',
          devTools: () => [
            bad('Bad-Name'),
            bad('nodescription', { description: '' }),
            bad('list_entries'), // telescope_list_entries is telescope's own
            bad('telescope_demo_list'), // already served for "demo"
            bad('telescope_broken_ok'),
          ],
        },
      ],
    });
    const names = telescope()?.tools.map((t) => t.name) ?? [];
    expect(names.filter((n) => n === 'telescope_list_entries')).toHaveLength(1);
    expect(names).toContain('telescope_demo_list');
    expect(names).toContain('telescope_broken_ok');
    expect(names.every((n) => /^telescope_[a-z0-9]+(_[a-z0-9]+)*$/.test(n))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    const warnings = warn.mock.calls.map((c) => String(c[0]));
    expect(
      warnings.filter((m) => m.includes('of the "broken" extension is not served')),
    ).toHaveLength(4);
  });

  it('refuses a caller limited to some organizations', async () => {
    const tools = extensionDevTools(
      extension.devTools(),
      () => 'demo',
      () => ({ empty: true, key: '', accept: () => false }),
      true,
    );
    await expect(tools[0]!.run({}, call)).rejects.toThrow(/every organization/);
    expect(runs).toHaveLength(0);
  });
});
