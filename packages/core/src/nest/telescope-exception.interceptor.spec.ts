// packages/core/src/nest/telescope-exception.interceptor.spec.ts
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeExceptionInterceptor } from './telescope-exception.interceptor.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

function buildInterceptor(options: TelescopeModuleOptions = {}) {
  const storage = new InMemoryStorageProvider();
  const service = new TelescopeService(resolveConfig({}), storage, options);
  const interceptor = new TelescopeExceptionInterceptor(service, options);
  return { storage, service, interceptor };
}

async function runThrow(
  interceptor: TelescopeExceptionInterceptor,
  error: unknown,
): Promise<unknown> {
  const next: CallHandler = { handle: () => throwError(() => error) };
  return lastValueFrom(interceptor.intercept({} as ExecutionContext, next)).catch((e) => e);
}

describe('TelescopeExceptionInterceptor', () => {
  it('records the thrown error and re-throws it', async () => {
    const { storage, service, interceptor } = buildInterceptor();

    const ctx = {} as ExecutionContext;
    const error = new TypeError('boom');
    const next: CallHandler = { handle: () => throwError(() => error) };

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(error);
    await service.flush();

    const entry = (await storage.get({ type: 'exception' })).data[0];
    expect(entry).toBeDefined();
    expect((entry?.content as { class: string }).class).toBe('TypeError');
    expect((entry?.content as { message: string }).message).toBe('boom');
    // familyHash now = name:message:topFrame so two unrelated call sites that
    // throw the same name+message stay distinct families. The top frame is the
    // real call site from this test, so assert the stable prefix + a frame.
    expect(entry?.familyHash).toMatch(/^TypeError:boom:at /);
  });

  it('passes successful streams through untouched', async () => {
    const { interceptor } = buildInterceptor();
    const { of } = await import('rxjs');
    const next: CallHandler = { handle: () => of('ok') };
    expect(await lastValueFrom(interceptor.intercept({} as ExecutionContext, next))).toBe('ok');
  });

  // The default changed (post-incident): expected 4xx control flow is NOT an
  // incident, so a 4xx HttpException must NOT open an exception family. The
  // request-capture middleware still records the 4xx statusCode separately, so
  // nothing is lost — it just can't fire new-exception or burn a diagnosis.
  it('does NOT record a 403 ForbiddenException by default (control flow, not incident)', async () => {
    const { storage, service, interceptor } = buildInterceptor();
    const error = new ForbiddenException('nope');

    expect(await runThrow(interceptor, error)).toBe(error);
    await service.flush();

    expect((await storage.get({ type: 'exception' })).data).toHaveLength(0);
  });

  it('does NOT record a 404 NotFoundException by default', async () => {
    const { storage, service, interceptor } = buildInterceptor();
    const error = new NotFoundException('missing');

    expect(await runThrow(interceptor, error)).toBe(error);
    await service.flush();

    expect((await storage.get({ type: 'exception' })).data).toHaveLength(0);
  });

  it('does NOT record a 400 BadRequestException (validation) by default', async () => {
    const { storage, service, interceptor } = buildInterceptor();
    const error = new BadRequestException(['name must not be empty']);

    expect(await runThrow(interceptor, error)).toBe(error);
    await service.flush();

    expect((await storage.get({ type: 'exception' })).data).toHaveLength(0);
  });

  it('records a 500 InternalServerErrorException (real server error)', async () => {
    const { storage, service, interceptor } = buildInterceptor();
    const error = new InternalServerErrorException('db down');

    expect(await runThrow(interceptor, error)).toBe(error);
    await service.flush();

    const entries = (await storage.get({ type: 'exception' })).data;
    expect(entries).toHaveLength(1);
    expect((entries[0]?.content as { class: string }).class).toBe('InternalServerErrorException');
  });

  it('records a custom HttpException with a 5xx status', async () => {
    const { storage, service, interceptor } = buildInterceptor();
    const error = new HttpException('gateway', HttpStatus.BAD_GATEWAY);

    expect(await runThrow(interceptor, error)).toBe(error);
    await service.flush();

    expect((await storage.get({ type: 'exception' })).data).toHaveLength(1);
  });

  it('records a non-HTTP Error even at a "4xx-looking" message', async () => {
    const { storage, service, interceptor } = buildInterceptor();
    // A plain Error is never control flow — it must always be captured.
    const error = new Error('403 forbidden');

    expect(await runThrow(interceptor, error)).toBe(error);
    await service.flush();

    expect((await storage.get({ type: 'exception' })).data).toHaveLength(1);
  });

  it('restores 4xx capture when exceptions.captureHttp4xx is true (escape hatch)', async () => {
    const { storage, service, interceptor } = buildInterceptor({
      exceptions: { captureHttp4xx: true },
    });
    const error = new ForbiddenException('nope');

    expect(await runThrow(interceptor, error)).toBe(error);
    await service.flush();

    const entries = (await storage.get({ type: 'exception' })).data;
    expect(entries).toHaveLength(1);
    expect((entries[0]?.content as { class: string }).class).toBe('ForbiddenException');
  });
});
