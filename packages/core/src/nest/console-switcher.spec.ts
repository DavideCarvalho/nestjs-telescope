import 'reflect-metadata';
import { type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { authorizeByToken } from './console-authorize.js';
import type { ConsoleDecision } from './console-authorize.js';
import {
  AVIARY_CONSOLES_SLOT,
  type AviaryConsoleEntry,
  type AviaryConsoleRegistry,
  consoleSwitcherConfig,
  isConsoleProbe,
  listVisibleConsoles,
  readAviaryConsoles,
  registerAviaryConsole,
  searchVisibleConsoles,
} from './console-switcher.js';
import { TelescopeModule } from './telescope.module.js';
const TOKEN = 'console-token-123';
const holder = globalThis as Record<symbol, unknown>;
const context = {} as ExecutionContext;

const allow = async (): Promise<ConsoleDecision> => ({ allowed: true });
const deny = async (): Promise<ConsoleDecision> => ({ allowed: false, reason: 'forbidden' });

function entry(overrides: Partial<AviaryConsoleEntry> & { id: string }): AviaryConsoleEntry {
  return {
    title: overrides.id,
    icon: 'generic',
    path: `/${overrides.id}`,
    order: 50,
    authorize: allow,
    ...overrides,
  };
}

function registry(...entries: AviaryConsoleEntry[]): AviaryConsoleRegistry {
  return { version: 1, entries };
}

beforeEach(() => {
  delete holder[AVIARY_CONSOLES_SLOT];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registerAviaryConsole', () => {
  it('creates the registry when absent, and the returned function removes the entry', () => {
    const remove = registerAviaryConsole(entry({ id: 'agent' }));
    expect(readAviaryConsoles()?.entries.map((e) => e.id)).toEqual(['agent']);
    remove?.();
    expect(readAviaryConsoles()?.entries).toEqual([]);
  });

  it('appends to a registry another console created (two copies, one registry)', () => {
    const existing = registry(entry({ id: 'durable' }));
    holder[AVIARY_CONSOLES_SLOT] = existing;
    registerAviaryConsole(entry({ id: 'agent' }));
    expect(holder[AVIARY_CONSOLES_SLOT]).toBe(existing);
    expect(existing.entries.map((e) => e.id)).toEqual(['durable', 'agent']);
  });

  it('leaves a registry of another version alone', () => {
    const future = { version: 2, entries: [] };
    holder[AVIARY_CONSOLES_SLOT] = future;
    expect(registerAviaryConsole(entry({ id: 'agent' }))).toBeUndefined();
    expect(future.entries).toEqual([]);
  });

  it('warns and skips a duplicate id', () => {
    const warn = vi.fn();
    registerAviaryConsole(entry({ id: 'agent' }));
    expect(registerAviaryConsole(entry({ id: 'agent', title: 'Other' }), { warn })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('console id "agent" is already registered');
    expect(readAviaryConsoles()?.entries).toHaveLength(1);
  });

  it('rejects a bad id or a path that is not same-origin', () => {
    expect(() => registerAviaryConsole(entry({ id: 'Agent' }))).toThrow(/id/);
    expect(() => registerAviaryConsole(entry({ id: 'agent', path: '//evil.test' }))).toThrow(
      /path/,
    );
    expect(() => registerAviaryConsole(entry({ id: 'agent', path: 'https://x.test' }))).toThrow(
      /path/,
    );
  });
});

describe('consoleSwitcherConfig', () => {
  it('is absent when this console is alone or not registered, and counts the others', () => {
    expect(consoleSwitcherConfig('agent', '/a/consoles')).toBeUndefined();
    registerAviaryConsole(entry({ id: 'durable' }));
    expect(consoleSwitcherConfig('agent', '/a/consoles')).toBeUndefined();
    registerAviaryConsole(entry({ id: 'agent' }));
    expect(consoleSwitcherConfig('agent', '/a/consoles')).toEqual({
      endpoint: '/a/consoles',
      others: 1,
    });
  });
});

describe('listVisibleConsoles', () => {
  it('lists the allowed others by order then id, never self, with href = path', async () => {
    const result = await listVisibleConsoles(
      registry(
        entry({ id: 'media', order: 50, icon: 'media', title: 'Media' }),
        entry({ id: 'agent', order: 30, icon: 'agent' }),
        entry({ id: 'telescope', order: 20, icon: 'telescope', title: 'Telescope' }),
        entry({ id: 'durable', order: 10, icon: 'workflow', title: 'Workflows' }),
        entry({ id: 'aaa', order: 50 }),
      ),
      'agent',
      context,
    );
    expect(result).toEqual({
      version: 1,
      current: 'agent',
      consoles: [
        { id: 'durable', title: 'Workflows', icon: 'workflow', href: '/durable' },
        { id: 'telescope', title: 'Telescope', icon: 'telescope', href: '/telescope' },
        { id: 'aaa', title: 'aaa', icon: 'generic', href: '/aaa' },
        { id: 'media', title: 'Media', icon: 'media', href: '/media' },
      ],
    });
  });

  it('hides forbidden, redirectTo, rejecting and throwing entries, and returns no reason', async () => {
    const result = await listVisibleConsoles(
      registry(
        entry({ id: 'ok' }),
        entry({ id: 'forbidden', authorize: deny }),
        entry({
          id: 'redirect',
          authorize: async () => ({
            allowed: false,
            reason: 'unauthenticated',
            redirectTo: '/login',
          }),
        }),
        entry({ id: 'rejects', authorize: () => Promise.reject(new Error('boom')) }),
        entry({
          id: 'throws',
          authorize: () => {
            throw new Error('sync boom');
          },
        }),
      ),
      'agent',
      context,
    );
    expect(result.consoles.map((c) => c.id)).toEqual(['ok']);
    expect(JSON.stringify(result)).not.toMatch(/forbidden|unauthenticated|login|boom/);
  });

  it('passes the request context to each authorize', async () => {
    const authorize = vi.fn(allow);
    await listVisibleConsoles(registry(entry({ id: 'x', authorize })), 'agent', context);
    expect(authorize).toHaveBeenCalledWith(context);
  });

  it('maps an unknown icon to generic and drops an unsafe path', async () => {
    const result = await listVisibleConsoles(
      registry(
        entry({ id: 'odd', icon: 'rocket' as never }),
        entry({ id: 'evil', path: '//evil.test' }),
      ),
      'agent',
      context,
    );
    expect(result.consoles).toEqual([{ id: 'odd', title: 'odd', icon: 'generic', href: '/odd' }]);
  });

  it('runs every authorize in parallel, each given 300 ms; a slower one is hidden', async () => {
    vi.useFakeTimers();
    const settleAfter = (ms: number, decision: ConsoleDecision) => () =>
      new Promise<ConsoleDecision>((resolve) => setTimeout(() => resolve(decision), ms));
    const pending = listVisibleConsoles(
      registry(
        entry({ id: 'a', order: 1, authorize: settleAfter(250, { allowed: true }) }),
        entry({ id: 'b', order: 2, authorize: settleAfter(280, { allowed: true }) }),
        entry({ id: 'slow', order: 3, authorize: settleAfter(5_000, { allowed: true }) }),
      ),
      'agent',
      context,
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    // In sequence, a + b alone would take 530 ms; in parallel, everything settles by the timeout.
    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toBe(true);
    expect((await pending).consoles.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('answers an empty list without a registry', async () => {
    expect(await listVisibleConsoles(undefined, 'agent', context)).toEqual({
      version: 1,
      current: 'agent',
      consoles: [],
    });
  });
});

function httpContext(request: Record<string, unknown> = {}): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe('the probe marker', () => {
  it('is set on the request while other consoles’ authorize and search run, then removed', async () => {
    const seen: boolean[] = [];
    const req: Record<string, unknown> = {};
    const ctx = httpContext(req);
    const probe = entry({
      id: 'agent',
      authorize: async (c) => {
        seen.push(isConsoleProbe(c));
        return { allowed: true };
      },
      search: async (c) => {
        seen.push(isConsoleProbe(c));
        return [];
      },
    });
    await listVisibleConsoles(registry(probe), 'telescope', ctx);
    await searchVisibleConsoles(registry(probe), 'telescope', ctx, 'x');
    expect(seen).toEqual([true, true, true]);
    expect('aviaryProbe' in req).toBe(false);
    expect(isConsoleProbe(ctx)).toBe(false);
  });

  it('keeps a marker that was already there', async () => {
    const req: Record<string, unknown> = { aviaryProbe: false };
    await listVisibleConsoles(registry(entry({ id: 'agent' })), 'telescope', httpContext(req));
    expect(req.aviaryProbe).toBe(false);
  });
});

describe('searchVisibleConsoles', () => {
  const hit = (title: string, href = `/${title}`) => ({ title, href });

  it('asks self and every allowed console with a search, by order, 5 safe hits each', async () => {
    const queries: Array<[string, string, number]> = [];
    const search =
      (id: string, hits: unknown[]) => async (_c: unknown, q: string, limit: number) => {
        queries.push([id, q, limit]);
        return hits as never;
      };
    const result = await searchVisibleConsoles(
      registry(
        entry({
          id: 'telescope',
          order: 20,
          icon: 'telescope',
          search: search('telescope', [hit('t')]),
        }),
        entry({
          id: 'durable',
          order: 10,
          icon: 'workflow',
          title: 'Workflows',
          search: search('durable', [
            ...Array.from({ length: 7 }, (_, i) => hit(`run-${i}`)),
            { title: 'evil', href: 'https://evil.example' },
            { title: 'proto', href: '//evil.example' },
          ]),
        }),
        entry({ id: 'media', authorize: deny, search: search('media', [hit('m')]) }),
        entry({ id: 'agent' }),
        entry({ id: 'empty', search: search('empty', []) }),
      ),
      'telescope',
      httpContext(),
      '  run  ',
    );
    expect(queries.map(([id]) => id).sort()).toEqual(['durable', 'empty', 'telescope']);
    expect(queries.every(([, q, limit]) => q === 'run' && limit === 5)).toBe(true);
    expect(result.q).toBe('run');
    expect(result.partial).toBe(false);
    expect(result.results.map((r) => r.id)).toEqual(['durable', 'telescope']);
    expect(result.results[0]?.hits).toHaveLength(5);
    expect(result.results[0]?.hits.every((h) => h.href.startsWith('/run-'))).toBe(true);
  });

  it('reports partial results when a console’s authorize or search fails or is slow', async () => {
    vi.useFakeTimers();
    const pending = searchVisibleConsoles(
      registry(
        entry({ id: 'slow', search: () => new Promise(() => undefined) }),
        entry({
          id: 'broken',
          search: async () => {
            throw new Error('down');
          },
        }),
        entry({
          id: 'stuck',
          authorize: () => new Promise(() => undefined),
          search: async () => [hit('x')],
        }),
        entry({ id: 'ok', search: async () => [hit('ok')] }),
      ),
      'telescope',
      httpContext(),
      'q',
    );
    await vi.advanceTimersByTimeAsync(700);
    const result = await pending;
    expect(result.partial).toBe(true);
    expect(result.results.map((r) => r.id)).toEqual(['ok']);
  });

  it('answers nothing for an empty query or without a registry', async () => {
    const searched = vi.fn(async () => [hit('x')]);
    expect(
      await searchVisibleConsoles(
        registry(entry({ id: 'a', search: searched })),
        's',
        context,
        '  ',
      ),
    ).toEqual({ version: 1, q: '', partial: false, results: [] });
    expect(searched).not.toHaveBeenCalled();
    expect((await searchVisibleConsoles(undefined, 's', context, 'x')).results).toEqual([]);
  });
});

// ── HTTP ───────────────────────────────────────────────────────────────────

let app: INestApplication | undefined;

async function boot(options: Parameters<typeof TelescopeModule.forRoot>[0]) {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot({ storage: new InMemoryStorageProvider(), ...options })],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app.getHttpServer();
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const bearer = { authorization: `Bearer ${TOKEN}` };

describe('GET <path>/api/consoles', () => {
  it('is behind the console’s authorize', async () => {
    registerAviaryConsole(
      entry({ id: 'durable', order: 10, icon: 'workflow', title: 'Workflows' }),
    );
    const server = await boot({ authorize: authorizeByToken({ token: TOKEN }) });
    const denied = await request(server).get('/telescope/api/consoles').expect(401);
    expect(denied.body).toEqual({ error: 'unauthenticated' });
  });

  it('lists the others the viewer may open, private and uncached', async () => {
    registerAviaryConsole(
      entry({ id: 'durable', order: 10, icon: 'workflow', title: 'Workflows' }),
    );
    registerAviaryConsole(entry({ id: 'media', order: 50, authorize: deny }));
    registerAviaryConsole(
      entry({
        id: 'agent',
        order: 30,
        icon: 'agent',
        title: 'Agents',
        // Sees the same request the telescope console was asked with.
        authorize: async (ctx) => ({
          allowed:
            ctx.switchToHttp().getRequest<{ headers: Record<string, string> }>().headers[
              'x-agent'
            ] === 'yes',
        }),
      }),
    );
    const server = await boot({
      path: 'ops/telescope',
      authorize: authorizeByToken({ token: TOKEN }),
    });
    const res = await request(server)
      .get('/ops/telescope/api/consoles')
      .set(bearer)
      .set('x-agent', 'yes')
      .expect(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toEqual({
      version: 1,
      current: 'telescope',
      consoles: [
        { id: 'durable', title: 'Workflows', icon: 'workflow', href: '/durable' },
        { id: 'agent', title: 'Agents', icon: 'agent', href: '/agent' },
      ],
    });
    const without = await request(server)
      .get('/ops/telescope/api/consoles')
      .set(bearer)
      .expect(200);
    expect(without.body.consoles.map((c: { id: string }) => c.id)).toEqual(['durable']);
  });

  it('is not mounted with routes: false', async () => {
    const server = await boot({ routes: false, authorize: () => true });
    await request(server).get('/telescope/api/consoles').expect(404);
  });
});

describe('GET <path>/api/consoles/search', () => {
  it('is behind the console’s authorize, and searches the allowed consoles', async () => {
    registerAviaryConsole(
      entry({
        id: 'durable',
        order: 10,
        icon: 'workflow',
        title: 'Workflows',
        search: async (_c, q) => [
          { title: `run ${q}`, subtitle: 'completed', href: '/durable#/run/1' },
        ],
      }),
    );
    const server = await boot({ authorize: authorizeByToken({ token: TOKEN }) });
    await request(server).get('/telescope/api/consoles/search?q=42').expect(401);
    const res = await request(server)
      .get('/telescope/api/consoles/search?q=42')
      .set(bearer)
      .expect(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toEqual({
      version: 1,
      q: '42',
      partial: false,
      results: [
        {
          id: 'durable',
          title: 'Workflows',
          icon: 'workflow',
          hits: [{ title: 'run 42', subtitle: 'completed', href: '/durable#/run/1' }],
        },
      ],
    });
  });
});
