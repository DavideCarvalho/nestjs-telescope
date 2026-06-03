// packages/core/src/nest/telescope-action.guard.spec.ts
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { QueueActionRequest } from '../queue/queue-manager.js';
import { TelescopeActionGuard } from './telescope-action.guard.js';
import type { TelescopeModuleOptions } from './telescope.options.js';

function ctx(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const RETRY_REQUEST = {
  params: { driver: 'bullmq', queue: 'q1', action: 'retry', id: '5' },
  query: {},
};

describe('TelescopeActionGuard', () => {
  it('denies (false) when no authorizeAction is configured', async () => {
    const guard = new TelescopeActionGuard({} as TelescopeModuleOptions);
    expect(await guard.canActivate(ctx(RETRY_REQUEST))).toBe(false);
  });

  it('allows and calls authorizeAction with the resolved action object', async () => {
    const authorizeAction = vi.fn(() => true);
    const guard = new TelescopeActionGuard({ authorizeAction } as TelescopeModuleOptions);
    expect(await guard.canActivate(ctx(RETRY_REQUEST))).toBe(true);
    expect(authorizeAction).toHaveBeenCalledTimes(1);
    const expectedAction: QueueActionRequest = {
      driver: 'bullmq',
      queue: 'q1',
      action: 'retry',
      jobId: '5',
    };
    expect(authorizeAction).toHaveBeenCalledWith({ request: RETRY_REQUEST }, expectedAction);
  });

  it('denies when authorizeAction returns false', async () => {
    const guard = new TelescopeActionGuard({
      authorizeAction: () => false,
    } as TelescopeModuleOptions);
    expect(await guard.canActivate(ctx(RETRY_REQUEST))).toBe(false);
  });

  it('fails closed (deny) when authorizeAction throws', async () => {
    const guard = new TelescopeActionGuard({
      authorizeAction: () => {
        throw new Error('x');
      },
    } as TelescopeModuleOptions);
    expect(await guard.canActivate(ctx(RETRY_REQUEST))).toBe(false);
  });

  it('denies an invalid action param without calling authorizeAction', async () => {
    const authorizeAction = vi.fn(() => true);
    const guard = new TelescopeActionGuard({ authorizeAction } as TelescopeModuleOptions);
    const bogus = {
      params: { driver: 'bullmq', queue: 'q1', action: 'bogus', id: '5' },
      query: {},
    };
    expect(await guard.canActivate(ctx(bogus))).toBe(false);
    expect(authorizeAction).not.toHaveBeenCalled();
  });

  it('carries query.state into the action for retry-all', async () => {
    const authorizeAction = vi.fn(() => true);
    const guard = new TelescopeActionGuard({ authorizeAction } as TelescopeModuleOptions);
    const retryAll = {
      params: { driver: 'bullmq', queue: 'q1', action: 'retry-all' },
      query: { state: 'failed' },
    };
    expect(await guard.canActivate(ctx(retryAll))).toBe(true);
    const expectedAction: QueueActionRequest = {
      driver: 'bullmq',
      queue: 'q1',
      action: 'retry-all',
      state: 'failed',
    };
    expect(authorizeAction).toHaveBeenCalledWith({ request: retryAll }, expectedAction);
  });
});
