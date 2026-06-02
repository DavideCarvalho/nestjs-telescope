// packages/core/src/nest/telescope-exception.interceptor.spec.ts
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeService } from './telescope.service.js';
import { TelescopeExceptionInterceptor } from './telescope-exception.interceptor.js';

describe('TelescopeExceptionInterceptor', () => {
  it('records the thrown error and re-throws it', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const interceptor = new TelescopeExceptionInterceptor(service);

    const ctx = {} as ExecutionContext;
    const error = new TypeError('boom');
    const next: CallHandler = { handle: () => throwError(() => error) };

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(error);
    await service.flush();

    const entry = (await storage.get({ type: 'exception' })).data[0];
    expect(entry).toBeDefined();
    expect((entry?.content as { class: string }).class).toBe('TypeError');
    expect((entry?.content as { message: string }).message).toBe('boom');
    expect(entry?.familyHash).toBe('TypeError:boom'); // groups recurring exceptions
  });

  it('passes successful streams through untouched', async () => {
    const service = new TelescopeService(resolveConfig({}), new InMemoryStorageProvider(), {});
    const interceptor = new TelescopeExceptionInterceptor(service);
    const { of } = await import('rxjs');
    const next: CallHandler = { handle: () => of('ok') };
    expect(await lastValueFrom(interceptor.intercept({} as ExecutionContext, next))).toBe('ok');
  });
});
