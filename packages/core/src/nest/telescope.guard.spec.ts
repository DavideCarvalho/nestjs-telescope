// packages/core/src/nest/telescope.guard.spec.ts
import type { ExecutionContext } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { TelescopeGuard } from './telescope.guard.js';

function ctx(): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ url: '/telescope/api/meta' }) }),
  } as unknown as ExecutionContext;
}

describe('TelescopeGuard', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = original; });

  it('uses the provided authorizer when set', async () => {
    const guard = new TelescopeGuard({ authorizer: () => true });
    expect(await guard.canActivate(ctx())).toBe(true);
    const deny = new TelescopeGuard({ authorizer: () => false });
    expect(await deny.canActivate(ctx())).toBe(false);
  });

  it('defaults to allow outside production', async () => {
    process.env.NODE_ENV = 'development';
    const guard = new TelescopeGuard({});
    expect(await guard.canActivate(ctx())).toBe(true);
  });

  it('defaults to DENY in production when no authorizer is set', async () => {
    process.env.NODE_ENV = 'production';
    const guard = new TelescopeGuard({});
    expect(await guard.canActivate(ctx())).toBe(false);
  });
});
