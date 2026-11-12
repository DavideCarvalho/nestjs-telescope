import 'reflect-metadata';
import { type INestApplication, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionRegistry } from '../extension/registry.js';
import {
  type ExtensionActionContext,
  type ExtensionContext,
  defineTelescopeExtension,
} from '../extension/types.js';
import { consoleCallerOf } from './extension-audit.js';
import { TelescopeModule } from './telescope.module.js';
import type { TelescopeModuleOptions } from './telescope.options.js';

const runs: Array<{ input: Record<string, unknown>; ctx: ExtensionActionContext }> = [];

const ext = defineTelescopeExtension({
  name: 'demo',
  actions: () => [
    {
      name: 'reset',
      label: 'Reset',
      confirm: 'Reset {name}?',
      destructive: true,
      run: async (input, ctx) => {
        runs.push({ input, ctx });
        if (input.name === 'missing') throw new NotFoundException('No such thing.');
        if (input.name === 'boom') throw new Error('kaboom');
        if (input.name === 'busy') throw Object.assign(new Error('Not now.'), { status: 503 });
        return { reset: input.name };
      },
    },
  ],
});

let app: INestApplication | undefined;

async function makeApp(options: Partial<TelescopeModuleOptions> = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot({ enabled: true, extensions: [ext], ...options })],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  runs.length = 0;
  vi.restoreAllMocks();
});

const post = (server: INestApplication, path: string) =>
  request(server.getHttpServer()).post(`/telescope/api/ext/${path}`);

describe('POST /telescope/api/ext/:ext/actions/:action', () => {
  it('is a mutation: 403 while mutations are off', async () => {
    await makeApp();
    await post(app!, 'demo/actions/reset').send({ confirmed: true, input: {} }).expect(403);
    expect(runs).toHaveLength(0);
  });

  it('runs the action with its input and the caller, and writes an audit line', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await makeApp({ mutations: true });
    const res = await post(app!, 'demo/actions/reset')
      .set('authorization', 'Bearer secret-token')
      .send({ confirmed: true, input: { name: 'stripe' } })
      .expect(200);
    expect(res.body).toEqual({ ok: true, result: { reset: 'stripe' } });
    expect(runs[0]?.input).toEqual({ name: 'stripe' });
    expect(runs[0]?.ctx.caller.via).toBe('console');
    expect(runs[0]?.ctx.caller.id).toMatch(/^token:[0-9a-f]{12}$/);
    expect(runs[0]?.ctx.moduleRef).toBeDefined();
    const line = log.mock.calls
      .map((call) => String(call[0]))
      .find((m) => m.includes('demo.reset'));
    expect(line).toMatch(/^extension action demo\.reset ok by token:[0-9a-f]{12} via console/);
    expect(line).not.toContain('secret-token');
  });

  it('refuses without { confirmed: true }', async () => {
    await makeApp({ mutations: true });
    await post(app!, 'demo/actions/reset')
      .send({ input: { name: 'x' } })
      .expect(400);
    expect(runs).toHaveLength(0);
  });

  it('404s an unknown action or one owned by another extension', async () => {
    await makeApp({ mutations: true });
    await post(app!, 'demo/actions/nope').send({ confirmed: true }).expect(404);
    await post(app!, 'other/actions/reset').send({ confirmed: true }).expect(404);
  });

  it('keeps an HttpException’s status and maps any other throw to 502', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await makeApp({ mutations: true });
    await post(app!, 'demo/actions/reset')
      .send({ confirmed: true, input: { name: 'missing' } })
      .expect(404);
    const res = await post(app!, 'demo/actions/reset')
      .send({ confirmed: true, input: { name: 'boom' } })
      .expect(502);
    expect(res.body.message).toBe('kaboom');
    const busy = await post(app!, 'demo/actions/reset')
      .send({ confirmed: true, input: { name: 'busy' } })
      .expect(503);
    expect(busy.body.message).toBe('Not now.');
    expect(log.mock.calls.filter((call) => String(call[0]).includes(' failed '))).toHaveLength(3);
  });

  it('lists the actions (without run) and the mutations switch in /meta', async () => {
    await makeApp({ mutations: true });
    const res = await request(app!.getHttpServer()).get('/telescope/api/meta').expect(200);
    expect(res.body.mutations).toBe(true);
    expect(res.body.actions).toEqual([
      { ext: 'demo', name: 'reset', label: 'Reset', confirm: 'Reset {name}?', destructive: true },
    ]);
  });
});

describe('consoleCallerOf', () => {
  it('names a signed-in user, a hashed token, or anonymous', () => {
    expect(consoleCallerOf({ user: { id: 42 }, headers: {} })).toBe('user:42');
    expect(consoleCallerOf({ user: { sub: 'abc' } })).toBe('user:abc');
    expect(consoleCallerOf({ headers: { authorization: 'Bearer t' } })).toMatch(/^token:/);
    expect(consoleCallerOf({ headers: {} })).toBe('anonymous');
    expect(consoleCallerOf(undefined)).toBe('anonymous');
  });
});

describe('ExtensionRegistry actions and dev tools', () => {
  const ctx = {} as ExtensionContext;
  const tool = (name: string) => ({
    name,
    kind: 'read' as const,
    description: name,
    input: { type: 'object' as const, properties: {} },
    run: async () => null,
  });

  it('collects actions and dev tools with their owners', () => {
    const registry = new ExtensionRegistry(
      [ext, { name: 'tools', devTools: () => [tool('tools_one')] }],
      ctx,
    );
    expect(registry.findAction('demo', 'reset')?.label).toBe('Reset');
    expect(registry.findAction('tools', 'reset')).toBeUndefined();
    const [only] = registry.devTools();
    expect(only?.name).toBe('tools_one');
    expect(registry.devToolOwner(only!)).toBe('tools');
  });

  it('rejects a dev tool name contributed twice', () => {
    expect(
      () =>
        new ExtensionRegistry(
          [
            { name: 'a', devTools: () => [tool('dup')] },
            { name: 'b', devTools: () => [tool('dup')] },
          ],
          ctx,
        ),
    ).toThrow(/"dup" is contributed by both "a" and "b"/);
  });

  it('rejects an action declared twice by one extension', () => {
    const run = async () => null;
    expect(
      () =>
        new ExtensionRegistry(
          [
            {
              name: 'a',
              actions: () => [
                { name: 'x', run },
                { name: 'x', run },
              ],
            },
          ],
          ctx,
        ),
    ).toThrow(/declares the action "x" twice/);
  });
});
