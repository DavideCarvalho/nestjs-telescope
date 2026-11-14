// packages/core/src/nest/telescope.module.authorization.e2e.spec.ts
//
// E2E against the REAL `@nestjs/authorization`: its `AuthorizationModule.forRoot()`
// registers a deny-by-default global `AuthorizationGuard`. Telescope's controllers
// must keep answering under it, and `decorators` must let the host put a `@Can()`
// in front of them.
import 'reflect-metadata';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import type { DynamicModule, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { StreamController } from '../sse/stream.controller.js';
import { ClientErrorController } from './client-error.controller.js';
import { AUTHORIZATION_CAN_ANYONE_METADATA } from './dynamic-controller.js';
import { TelescopeController } from './telescope.controller.js';
import { TelescopeModule } from './telescope.module.js';

type User = { id: string; admin: boolean };

@Policy()
class ConsolePolicy {
  view(user: User | null): boolean {
    return user?.admin === true;
  }
}

type Route = { method: 'get' | 'post'; url: string; body?: object };

/** One route per console controller TelescopeModule mounts (they take `decorators`). */
const CONSOLE_ROUTES: Route[] = [
  { method: 'get', url: '/telescope/api/meta' }, // TelescopeController
];

/** The public client-error beacon: no `decorators`, guests must reach it. */
const BEACON: Route = {
  method: 'post',
  url: '/telescope/api/client-errors',
  body: { message: 'x' },
};

const ROUTES: Route[] = [...CONSOLE_ROUTES, BEACON];

const META = CONSOLE_ROUTES[0] as Route;

/** The SSE stream (StreamController): it never ends once open, so it is probed apart. */
const STREAM_URL = '/telescope/api/stream';

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * Boots an app; `x-user` (JSON) becomes `request.user`, standing in for the
 * host's authentication (which runs before the global authorization guard).
 */
async function boot(imports: DynamicModule[], providers = [ConsolePolicy]) {
  const moduleRef = await Test.createTestingModule({ imports, providers }).compile();
  app = moduleRef.createNestApplication();
  app.use(
    (req: { headers: Record<string, string>; user?: unknown }, _res: unknown, next: () => void) => {
      const raw = req.headers['x-user'];
      if (raw) req.user = JSON.parse(raw);
      next();
    },
  );
  await app.init();
  return app;
}

/**
 * The status the SSE stream answers with. An allowed request opens a stream
 * that never ends, so read the status line and drop the connection.
 */
async function streamStatusOf(target: INestApplication, user?: User): Promise<number> {
  const server = target.getHttpServer() as http.Server;
  if (!server.listening) await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        port,
        path: STREAM_URL,
        headers: user ? { 'x-user': JSON.stringify(user) } : {},
      },
      (res) => {
        resolve(res.statusCode ?? 0);
        res.destroy();
        req.destroy();
      },
    );
    req.on('error', reject);
  });
}

async function statusOf(target: INestApplication, route: Route, user?: User) {
  const req = request(target.getHttpServer())[route.method](route.url);
  if (user) req.set('x-user', JSON.stringify(user));
  if (route.body) req.send(route.body);
  return (await req).status;
}

describe('TelescopeModule under @nestjs/authorization', () => {
  it('(a) every mounted controller answers exactly as before with the global guard on and no decorators', async () => {
    const baseline = await boot([TelescopeModule.forRoot({})]);
    const before: number[] = [];
    for (const route of ROUTES) before.push(await statusOf(baseline, route));
    await baseline.close();

    const guarded = await boot([AuthorizationModule.forRoot(), TelescopeModule.forRoot({})]);
    const after: number[] = [];
    for (const route of ROUTES) after.push(await statusOf(guarded, route));

    expect(after).toEqual(before);
    expect(after[0]).toBe(200);
  });

  it('(b) a Can() passed in decorators is enforced on every console controller: guest 401, denied 403, allowed through', async () => {
    const guarded = await boot([
      AuthorizationModule.forRoot(),
      TelescopeModule.forRoot({
        decorators: [Can(ConsolePolicy, 'view')],
        clientErrors: { enabled: true },
      }),
    ]);
    for (const route of CONSOLE_ROUTES) {
      expect(await statusOf(guarded, route), `guest ${route.url}`).toBe(401);
      expect(await statusOf(guarded, route, { id: 'u', admin: false }), `user ${route.url}`).toBe(
        403,
      );
      const allowed = await statusOf(guarded, route, { id: 'a', admin: true });
      expect([401, 403], `admin ${route.url}`).not.toContain(allowed);
    }
    expect(await statusOf(guarded, META, { id: 'a', admin: true })).toBe(200);
    // The SSE stream is refused before it opens, and opens for an allowed user.
    expect(await streamStatusOf(guarded), 'guest stream').toBe(401);
    expect(await streamStatusOf(guarded, { id: 'u', admin: false }), 'user stream').toBe(403);
    expect(await streamStatusOf(guarded, { id: 'a', admin: true }), 'admin stream').toBe(200);
    // The public beacon is left out of `decorators`: a guest still reports an error.
    expect(await statusOf(guarded, BEACON)).toBe(204);
  });

  it('(b) forRootAsync takes decorators as a static top-level option', async () => {
    const guarded = await boot([
      AuthorizationModule.forRoot(),
      TelescopeModule.forRootAsync({
        useFactory: () => ({}),
        decorators: [Can(ConsolePolicy, 'view')],
      }),
    ]);
    expect(await statusOf(guarded, META, { id: 'u', admin: false })).toBe(403);
    expect(await statusOf(guarded, META, { id: 'a', admin: true })).toBe(200);
  });

  it('(c) decorators from one registration do not leak into the next', async () => {
    const first = await boot([
      AuthorizationModule.forRoot(),
      TelescopeModule.forRoot({ decorators: [Can(ConsolePolicy, 'view')] }),
    ]);
    expect(await statusOf(first, META, { id: 'u', admin: false })).toBe(403);
    await first.close();

    const second = await boot([AuthorizationModule.forRoot(), TelescopeModule.forRoot({})]);
    expect(await statusOf(second, META, { id: 'u', admin: false })).toBe(200);

    // The shared base classes never receive the host's metadata.
    for (const base of [TelescopeController, StreamController, ClientErrorController]) {
      expect(Reflect.getMetadata('authorization:can', base)).toBeUndefined();
      expect(Reflect.getMetadata(AUTHORIZATION_CAN_ANYONE_METADATA, base)).toBeUndefined();
    }
  });

  it('marks every mounted controller (including the SSE stream) open, and applies decorators to each console controller', () => {
    const marker: ClassDecorator = (target) => {
      Reflect.defineMetadata('test:marked', true, target);
    };
    for (const mod of [
      TelescopeModule.forRoot({ decorators: [marker] }),
      TelescopeModule.forRootAsync({ useFactory: () => ({}), decorators: [marker] }),
    ]) {
      expect(mod.controllers).toHaveLength(4);
      for (const controller of mod.controllers ?? []) {
        expect(Reflect.getMetadata(AUTHORIZATION_CAN_ANYONE_METADATA, controller)).toBe(true);
        const isBeacon = controller.prototype instanceof ClientErrorController;
        expect(Reflect.getMetadata('test:marked', controller), controller.name).toBe(
          isBeacon ? undefined : true,
        );
      }
    }
  });
});
