// E2E against the REAL `@nestjs/observe` TracerService. Telescope only READS the trace id
// (`currentTraceId()`); it never touches Observe's spans, metrics or exporter. The agent runs with
// no credentials and its endpoint on a closed local port, so nothing is sent anywhere.
import 'reflect-metadata';
import {
  InMemoryStorageProvider,
  TelescopeModule,
  TelescopeService,
} from '@dudousxd/nestjs-telescope';
import { Controller, Get, type INestApplication, Inject } from '@nestjs/common';
import { TracerService, createObserveModule } from '@nestjs/observe';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObserveTraceContextProvider, toW3cTraceId } from './observe-trace-context.provider.js';

const { ObserveModule, ObserveInstrument } = createObserveModule();

@Controller('observed')
class ObservedController {
  constructor(@Inject(TracerService) private readonly tracer: TracerService) {}

  @Get()
  read() {
    return { observeTraceId: this.tracer.currentTraceId() };
  }
}

describe('ObserveTraceContextProvider (e2e, real @nestjs/observe)', () => {
  let app: INestApplication;
  const storage = new InMemoryStorageProvider();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ObserveModule.forRoot({
          serviceId: 'telescope-e2e',
          endpoint: 'http://127.0.0.1:9',
        }),
        TelescopeModule.forRootAsync({
          routes: false,
          inject: [TracerService],
          useFactory: (...args: unknown[]) => ({
            enabled: true,
            storage,
            traceContext: new ObserveTraceContextProvider(args[0] as TracerService),
          }),
        }),
      ],
      controllers: [ObservedController],
    }).compile();
    app = moduleRef.createNestApplication({ instrument: ObserveInstrument! });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("stamps each entry with Observe's trace id, as 32 hex digits", async () => {
    const res = await request(app.getHttpServer()).get('/observed').expect(200);
    const observeTraceId = (res.body as { observeTraceId: string | null }).observeTraceId;
    expect(observeTraceId).toEqual(expect.any(String));
    await app.get(TelescopeService).flush();
    const [entry] = (await storage.get({ type: 'request' })).data;
    expect(entry?.traceId).toBe(toW3cTraceId(observeTraceId));
    expect(entry?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(entry?.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps the trace id the caller sent in x-request-id', async () => {
    const id = '4bf92f35-77b3-4da6-a3ce-929d0e0e4736';
    await request(app.getHttpServer()).get('/observed').set('x-request-id', id).expect(200);
    await app.get(TelescopeService).flush();
    const entries = (await storage.get({ type: 'request' })).data;
    expect(entries.map((e) => e.traceId)).toContain('4bf92f3577b34da6a3ce929d0e0e4736');
  });
});
