// packages/core/src/nest/async-static-options.spec.ts
import 'reflect-metadata';
import { type INestApplication, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withStaticOptions } from './async-static-options.js';
import { TelescopeModule } from './telescope.module.js';
import { TELESCOPE_OPTIONS } from './telescope.options.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

const marker: ClassDecorator = () => {};

function capture() {
  const warn = vi.fn<(message: string) => void>();
  return { logger: { warn }, warn };
}

describe('withStaticOptions', () => {
  it('logs every build-time option the factory returned, by name', () => {
    const { logger, warn } = capture();
    withStaticOptions({ decorators: [marker], mcpDecorators: [marker], routes: false }, {}, logger);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /`decorators`, `mcpDecorators`, `routes` returned by useFactory have no effect/,
    );
  });

  it('says nothing when the factory returns only runtime options', () => {
    const { logger, warn } = capture();
    const resolved: TelescopeModuleOptions = { mcp: true, mutations: true };
    expect(withStaticOptions(resolved, { decorators: [marker] }, logger)).toEqual(resolved);
    expect(warn).not.toHaveBeenCalled();
  });

  it('copies the static path into the resolved options', () => {
    const { logger, warn } = capture();
    expect(withStaticOptions({ mcp: true }, { path: 'ops/telescope' }, logger).path).toBe(
      'ops/telescope',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the static path over a different factory path, and logs it', () => {
    const { logger, warn } = capture();
    expect(withStaticOptions({ path: 'other' }, { path: '/ops/telescope/' }, logger).path).toBe(
      '/ops/telescope/',
    );
    expect(warn.mock.calls[0]?.[0]).toMatch(/differs from the static `path: 'ops\/telescope'`/);
  });

  it('accepts the same path from both, however it is slashed', () => {
    const { logger, warn } = capture();
    withStaticOptions({ path: '/ops/telescope' }, { path: 'ops/telescope/' }, logger);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a factory path with no static one, logging it unless routes: false', () => {
    const mounted = capture();
    expect(withStaticOptions({ path: 'ops' }, {}, mounted.logger).path).toBe('ops');
    expect(mounted.warn.mock.calls[0]?.[0]).toMatch(/does not move the routes/);

    const selfMounted = capture();
    expect(withStaticOptions({ path: 'ops' }, { routes: false }, selfMounted.logger).path).toBe(
      'ops',
    );
    expect(selfMounted.warn).not.toHaveBeenCalled();
  });
});

describe('TelescopeModule.forRootAsync with static options', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('hands the static path to the providers, so the service agrees with the mount', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRootAsync({ path: 'ops/telescope', useFactory: () => ({}) })],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    expect(app.get(TelescopeService).path).toBe('ops/telescope');
    expect((app.get(TELESCOPE_OPTIONS) as TelescopeModuleOptions).path).toBe('ops/telescope');
    expect((await request(app.getHttpServer()).get('/ops/telescope/api/meta')).status).toBe(200);
  });

  it('does not apply decorators returned by the factory (they are logged instead)', async () => {
    const deny = { canActivate: () => false };
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRootAsync({
          useFactory: () => ({ mcp: true, mcpDecorators: [UseGuards(deny)] }),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    // The guard never reached the MCP route: it answers.
    const res = await request(app.getHttpServer())
      .post('/telescope/api/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(200);
  });
});
