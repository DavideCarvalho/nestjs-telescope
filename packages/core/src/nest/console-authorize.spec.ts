// packages/core/src/nest/console-authorize.spec.ts
import 'reflect-metadata';
import { type ExecutionContext, Inject, Injectable, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  CONSOLE_GATE,
  type ConsoleAuthorizer,
  authorizeByToken,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from './console-authorize.js';

function contextFor(request: { headers?: Record<string, unknown>; user?: unknown; url?: string }) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

const ctx = contextFor({ headers: {} });

async function moduleRefWith(providers: unknown[] = []): Promise<ModuleRef> {
  const testing = await Test.createTestingModule({ providers: providers as never[] }).compile();
  return testing.get(ModuleRef);
}

@Injectable()
class Dependency {
  readonly value = 'injected';
}

@Injectable()
class ClassAuthorizer implements ConsoleAuthorizer {
  static instances = 0;
  constructor(@Inject(Dependency) readonly dependency: Dependency) {
    ClassAuthorizer.instances++;
  }
  authorize() {
    return this.dependency?.value === 'injected';
  }
}

describe('normalizeConsoleAuthorizeResult', () => {
  it.each([
    [true, { allowed: true }],
    [{ allowed: true }, { allowed: true }],
    [false, { allowed: false, reason: 'forbidden' }],
    [{ allowed: false }, { allowed: false, reason: 'forbidden' }],
    [
      { allowed: false, reason: 'forbidden' },
      { allowed: false, reason: 'forbidden' },
    ],
    [
      { allowed: false, reason: 'unauthenticated' },
      { allowed: false, reason: 'unauthenticated' },
    ],
    [{ redirectTo: '/login' }, { allowed: false, reason: 'unauthenticated', redirectTo: '/login' }],
    [undefined, { allowed: false, reason: 'forbidden' }],
    ['yes', { allowed: false, reason: 'forbidden' }],
  ])('%j → %j', (result, decision) => {
    expect(normalizeConsoleAuthorizeResult(result)).toEqual(decision);
  });
});

describe('resolveConsoleAuthorize', () => {
  it('inline function: called with the context', async () => {
    const fn = vi.fn(async () => ({ allowed: false as const, reason: 'unauthenticated' as const }));
    const check = resolveConsoleAuthorize(fn, await moduleRefWith());
    expect(await check(ctx)).toEqual({ allowed: false, reason: 'unauthenticated' });
    expect(fn).toHaveBeenCalledWith(ctx);
  });

  it('class: built through DI once per registration', async () => {
    ClassAuthorizer.instances = 0;
    const check = resolveConsoleAuthorize(ClassAuthorizer, await moduleRefWith([Dependency]));
    expect(await check(ctx)).toEqual({ allowed: true });
    expect(await check(ctx)).toEqual({ allowed: true });
    expect(ClassAuthorizer.instances).toBe(1);
  });

  it('class: uses the registered provider when there is one', async () => {
    ClassAuthorizer.instances = 0;
    const moduleRef = await moduleRefWith([Dependency, ClassAuthorizer]);
    const before = ClassAuthorizer.instances;
    const check = resolveConsoleAuthorize(ClassAuthorizer, moduleRef);
    expect(await check(ctx)).toEqual({ allowed: true });
    expect(ClassAuthorizer.instances).toBe(before);
  });

  it('lazy import: imported once, then built through DI', async () => {
    ClassAuthorizer.instances = 0;
    const load = vi.fn(async () => ({ default: ClassAuthorizer }));
    const check = resolveConsoleAuthorize(load, await moduleRefWith([Dependency]));
    expect(await check(ctx)).toEqual({ allowed: true });
    expect(await check(ctx)).toEqual({ allowed: true });
    expect(load).toHaveBeenCalledTimes(1);
    expect(ClassAuthorizer.instances).toBe(1);
  });

  it('policy check: delegates to AuthorizationService with the user', async () => {
    const { AuthorizationModule, Policy } = await import('@nestjs/authorization');
    @Policy()
    class ConsolePolicy {
      view(user: { admin: boolean } | null) {
        return user?.admin === true;
      }
    }
    @Module({ imports: [AuthorizationModule.forRoot()], providers: [ConsolePolicy] })
    class AppModule {}
    const testing = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await testing.init();
    const check = resolveConsoleAuthorize(
      { policy: ConsolePolicy, ability: 'view' },
      testing.get(ModuleRef),
    );
    await check.ready;
    expect(await check(contextFor({ user: { admin: true } }))).toEqual({ allowed: true });
    expect(await check(contextFor({ user: { admin: false } }))).toEqual({
      allowed: false,
      reason: 'forbidden',
    });
    expect(await check(contextFor({}))).toEqual({ allowed: false, reason: 'unauthenticated' });
  });

  it('policy check: ready rejects without AuthorizationModule', async () => {
    class ConsolePolicy {}
    const check = resolveConsoleAuthorize(
      { policy: ConsolePolicy, ability: 'view' },
      await moduleRefWith(),
    );
    await expect(check.ready).rejects.toThrow(/AuthorizationModule\.forRoot\(\)/);
    expect(await check(ctx)).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('gate name: asks the console-gate provider', async () => {
    const allows = vi.fn(async () => true);
    const check = resolveConsoleAuthorize(
      'console.telescope',
      await moduleRefWith([{ provide: CONSOLE_GATE, useValue: { allows } }]),
    );
    expect(await check(ctx)).toEqual({ allowed: true });
    expect(allows).toHaveBeenCalledWith('console.telescope', ctx);
  });

  it('gate name: throws at resolution without the provider', async () => {
    const moduleRef = await moduleRefWith();
    expect(() => resolveConsoleAuthorize('console.telescope', moduleRef)).toThrow(
      "`authorize: 'console.telescope'` needs @dudousxd/nestjs-authz's AuthzModule (it resolves gate names); or pass a function, a class, or { policy, ability }.",
    );
  });

  it('a throw is a forbidden denial, never an allow', async () => {
    const check = resolveConsoleAuthorize(
      () => {
        throw new Error('boom');
      },
      await moduleRefWith(),
    );
    expect(await check(ctx)).toEqual({ allowed: false, reason: 'forbidden' });

    class Throws {
      authorize(): boolean {
        throw new Error('boom');
      }
    }
    const classCheck = resolveConsoleAuthorize(Throws, await moduleRefWith());
    expect(await classCheck(ctx)).toEqual({ allowed: false, reason: 'forbidden' });
  });
});

describe('authorizeByToken', () => {
  const check = authorizeByToken({ token: 's3cret' });

  it('allows a matching Bearer header', () => {
    expect(check(contextFor({ headers: { authorization: 'Bearer s3cret' } }))).toEqual({
      allowed: true,
    });
  });

  it('answers unauthenticated on a mismatch or a missing header', () => {
    const denied = { allowed: false, reason: 'unauthenticated' };
    expect(check(contextFor({ headers: { authorization: 'Bearer nope' } }))).toEqual(denied);
    expect(check(contextFor({ headers: {} }))).toEqual(denied);
    expect(check(contextFor({ headers: { authorization: 's3cret' } }))).toEqual(denied);
  });

  it('ignores ?token= and custom headers', () => {
    const denied = { allowed: false, reason: 'unauthenticated' };
    expect(check(contextFor({ url: '/telescope/api/meta?token=s3cret', headers: {} }))).toEqual(
      denied,
    );
    expect(check(contextFor({ headers: { 'x-telescope-token': 's3cret' } }))).toEqual(denied);
  });

  it('throws at config time for an empty or missing token', () => {
    expect(() => authorizeByToken({ token: '' })).toThrow(/`token` is empty/);
    expect(() => authorizeByToken({ token: undefined })).toThrow(/`token` is empty/);
  });
});
