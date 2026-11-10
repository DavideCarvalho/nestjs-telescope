// packages/core/src/nest/telescope.module.mcp-key.e2e.spec.ts
//
// E2E against the REAL `@nestjs/authentication` + `@nestjs/authorization`: the
// coding agent signs in to the MCP route with an API key (`ApiKeyProvider`,
// `Authorization: Bearer <key>`), people sign in to the rest of the console with
// their own credential, and `mcpDecorators` keeps each credential to its routes.
import 'reflect-metadata';
import {
  ApiKeyProvider,
  Authenticate,
  AuthenticationModule,
  AuthenticationProvider,
  AuthenticationRegistry,
} from '@nestjs/authentication';
import type { ApiKeyRecord, AuthenticationResult } from '@nestjs/authentication';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import {
  type ExecutionContext,
  type INestApplication,
  Inject,
  Injectable,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { TelescopeMcpController } from './telescope-mcp.controller.js';
import { TelescopeModule } from './telescope.module.js';

type User = { id: string; admin: boolean };

const ADMIN: User = { id: 'admin', admin: true };
const AGENT: User = { id: 'agent', admin: true };

@Policy()
class ConsolePolicy {
  view(user: User | null): boolean {
    return user?.admin === true;
  }
}

/** Stands in for the dashboard's session: `x-user` (JSON) is the signed-in user. */
@Injectable()
class HeaderAuth extends AuthenticationProvider<User> {
  constructor(@Inject(AuthenticationRegistry) registry: AuthenticationRegistry) {
    super();
    registry.registerProvider(this, { order: 1 });
  }
  authenticate(context: ExecutionContext): AuthenticationResult<User> | null {
    const raw = this.header(context, 'x-user');
    return raw ? { user: JSON.parse(raw) as User } : null;
  }
}

/** The agent's credential: one key, kept in memory here (a table in an app). */
const keys = new Map<string, ApiKeyRecord<User>>();

@Injectable()
class TelescopeAgentKey extends ApiKeyProvider<User> {
  constructor(@Inject(AuthenticationRegistry) registry: AuthenticationRegistry) {
    super({ prefix: 'tsc' });
    registry.registerProvider(this, { order: 2 });
  }
  findKey(id: string): ApiKeyRecord<User> | null {
    return keys.get(id) ?? null;
  }
}

@Module({
  providers: [HeaderAuth, TelescopeAgentKey, ConsolePolicy],
  exports: [TelescopeAgentKey],
})
class AuthProvidersModule {}

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  keys.clear();
});

async function boot(telescope: ReturnType<typeof TelescopeModule.forRoot>) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AuthenticationModule.forRoot({ allowInMemoryStorage: true }),
      AuthorizationModule.forRoot(),
      AuthProvidersModule,
      telescope,
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

const MCP_BODY = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

function mcp(target: INestApplication, headers: Record<string, string> = {}) {
  return request(target.getHttpServer()).post('/telescope/api/mcp').set(headers).send(MCP_BODY);
}

function meta(target: INestApplication, headers: Record<string, string> = {}) {
  return request(target.getHttpServer()).get('/telescope/api/meta').set(headers);
}

function issueKey(target: INestApplication, user: User): string {
  const generated = target.get(TelescopeAgentKey).generate();
  keys.set(generated.id, { hash: generated.hash, user });
  return generated.key;
}

const asUser = (user: User) => ({ 'x-user': JSON.stringify(user) });
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe('TelescopeModule mcpDecorators with @nestjs/authentication', () => {
  it('signs the agent in to MCP with an API key, and keeps the key off the other console routes', async () => {
    const target = await boot(
      TelescopeModule.forRoot({
        mcp: true,
        decorators: [Authenticate({ providers: [HeaderAuth] }), Can(ConsolePolicy, 'view')],
        mcpDecorators: [
          Authenticate({ providers: [TelescopeAgentKey] }),
          Can(ConsolePolicy, 'view'),
        ],
        imports: [AuthProvidersModule],
      }),
    );
    const key = issueKey(target, AGENT);

    // The agent: its key opens MCP, and the response is the tool list.
    const ok = await mcp(target, bearer(key));
    expect(ok.status).toBe(200);
    expect((ok.body as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);

    // No key, a wrong key, or the dashboard's credential: MCP refuses.
    expect((await mcp(target)).status).toBe(401);
    expect((await mcp(target, bearer(`${key.slice(0, -4)}AAAA`))).status).toBe(401);
    expect((await mcp(target, asUser(ADMIN))).status).toBe(401);

    // The key does not reach the API; the dashboard's credential does.
    expect((await meta(target, bearer(key))).status).toBe(401);
    expect((await meta(target, asUser(ADMIN))).status).toBe(200);
  });

  it('still applies the authorization policy to the key: a key for a non-admin is 403', async () => {
    const target = await boot(
      TelescopeModule.forRoot({
        mcp: true,
        decorators: [Authenticate({ providers: [HeaderAuth] }), Can(ConsolePolicy, 'view')],
        mcpDecorators: [
          Authenticate({ providers: [TelescopeAgentKey] }),
          Can(ConsolePolicy, 'view'),
        ],
        imports: [AuthProvidersModule],
      }),
    );
    const key = issueKey(target, { id: 'intern', admin: false });
    expect((await mcp(target, bearer(key))).status).toBe(403);
  });

  it('without mcpDecorators, MCP takes decorators like the rest of the console', async () => {
    const target = await boot(
      TelescopeModule.forRoot({
        mcp: true,
        decorators: [Authenticate({ providers: [HeaderAuth] }), Can(ConsolePolicy, 'view')],
        imports: [AuthProvidersModule],
      }),
    );
    const key = issueKey(target, AGENT);
    expect((await mcp(target, asUser(ADMIN))).status).toBe(200);
    expect((await mcp(target, bearer(key))).status).toBe(401);
  });
});

describe('TelescopeModule mcpDecorators at module build', () => {
  const marker =
    (name: string): ClassDecorator =>
    (target) => {
      Reflect.defineMetadata(`test:${name}`, true, target);
    };

  it('puts mcpDecorators on the MCP controller only, in place of decorators (forRoot and forRootAsync)', () => {
    for (const mod of [
      TelescopeModule.forRoot({ decorators: [marker('console')], mcpDecorators: [marker('mcp')] }),
      TelescopeModule.forRootAsync({
        useFactory: () => ({}),
        decorators: [marker('console')],
        mcpDecorators: [marker('mcp')],
      }),
    ]) {
      const controllers = mod.controllers ?? [];
      const isMcp = (c: (typeof controllers)[number]) =>
        c.prototype instanceof TelescopeMcpController;
      const mcpController = controllers.find(isMcp);
      expect(Reflect.getMetadata('test:mcp', mcpController as object)).toBe(true);
      expect(Reflect.getMetadata('test:console', mcpController as object)).toBeUndefined();
      for (const other of controllers.filter((c) => !isMcp(c))) {
        expect(Reflect.getMetadata('test:mcp', other), other.name).toBeUndefined();
      }
    }
  });

  describe('production rule', () => {
    const previous = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = previous;
    });

    it('fails the boot on mcpDecorators: [] instead of mounting MCP open', () => {
      process.env.NODE_ENV = 'production';
      expect(() =>
        TelescopeModule.forRoot({ decorators: [marker('console')], mcpDecorators: [] }),
      ).toThrow(/mcpDecorators/);
    });

    it('still requires decorators for the rest of the console when only mcpDecorators is set', () => {
      process.env.NODE_ENV = 'production';
      expect(() => TelescopeModule.forRoot({ mcpDecorators: [marker('mcp')] })).toThrow(
        /refusing to mount/,
      );
    });

    it('boots with both set, and with routes: false whatever mcpDecorators is', () => {
      process.env.NODE_ENV = 'production';
      expect(() =>
        TelescopeModule.forRoot({
          decorators: [marker('console')],
          mcpDecorators: [marker('mcp')],
        }),
      ).not.toThrow();
      expect(() => TelescopeModule.forRoot({ routes: false, mcpDecorators: [] })).not.toThrow();
    });
  });
});
