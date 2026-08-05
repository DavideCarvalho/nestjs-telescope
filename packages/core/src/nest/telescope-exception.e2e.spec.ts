// packages/core/src/nest/telescope-exception.e2e.spec.ts
//
// End-to-end over a real HTTP app: routes that throw, driven through supertest,
// asserted on the entries the real module stored.
//
// WHY: the exception decision + entry build moved out of the interceptor into
// `exception-capture.ts` so watchers can reach it. The interceptor's own spec
// exercises the interceptor in isolation; this one exercises the whole path the
// extraction could have broken — Nest pipeline → interceptor → shared capture →
// Recorder → storage → API — and pins the two behaviours that matter: the
// family hash and the 4xx skip that exists because of a real incident.
//
import 'reflect-metadata';
import { Controller, ForbiddenException, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { TelescopeModule } from './telescope.module.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

@Controller()
class BoomController {
  @Get('boom')
  boom(): never {
    throw new TypeError('kaboom');
  }

  @Get('denied')
  denied(): never {
    throw new ForbiddenException('nope');
  }
}

async function bootApp(options: TelescopeModuleOptions = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot({ authorizer: () => true, ...options })],
    controllers: [BoomController],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

async function entriesOf(app: INestApplication): Promise<Entry[]> {
  await app.get(TelescopeService).flush();
  const res = await request(app.getHttpServer()).get('/telescope/api/entries');
  return (res.body as { data: Entry[] }).data;
}

describe('Exception capture over HTTP (e2e)', () => {
  let app: INestApplication;
  afterEach(async () => {
    await app?.close();
  });

  it('records a 500 route throw as an exception in the request’s batch', async () => {
    app = await bootApp();

    await request(app.getHttpServer()).get('/boom').expect(500);

    const entries = await entriesOf(app);
    const exception = entries.find((entry) => entry.type === 'exception');
    const requestEntry = entries.find((entry) => entry.type === 'request');
    expect(exception).toBeDefined();
    expect(exception?.familyHash).toMatch(/^TypeError:kaboom:at /);
    expect(exception?.content).toMatchObject({ class: 'TypeError', message: 'kaboom' });
    // The interceptor supplies no extra context — the request entry in the same
    // batch already says which route it was.
    expect((exception?.content as { context: Record<string, unknown> }).context).toEqual({});
    expect(exception?.batchId).toBe(requestEntry?.batchId);
  });

  // The incident this default exists for: Telescope's own client-errors
  // `authorize` gate threw a 403, it was captured as a brand-new family, paged
  // Slack, and burned an AI diagnosis. The extraction must not re-open that door.
  it('does not record a 403 as an exception, and still answers 403', async () => {
    app = await bootApp();

    await request(app.getHttpServer()).get('/denied').expect(403);

    const entries = await entriesOf(app);
    expect(entries.filter((entry) => entry.type === 'exception')).toHaveLength(0);
    // Not lost: the request entry still carries the 4xx status code.
    const requestEntry = entries.find((entry) => entry.type === 'request');
    expect((requestEntry?.content as { statusCode: number }).statusCode).toBe(403);
  });

  it('restores 4xx capture under the captureHttp4xx escape hatch', async () => {
    app = await bootApp({ exceptions: { captureHttp4xx: true } });

    await request(app.getHttpServer()).get('/denied').expect(403);

    const entries = await entriesOf(app);
    const exception = entries.find((entry) => entry.type === 'exception');
    expect(exception).toBeDefined();
    expect(exception?.content).toMatchObject({ class: 'ForbiddenException' });
  });
});
