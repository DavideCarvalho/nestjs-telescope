// E2E against the REAL first-party packages: each route below runs a real flow of
// @nestjs/resilience / workflows / authentication / authorization / mail / ai inside an HTTP
// request, the package publishes on its diagnostics channel (or calls onUsage), and the entries
// must land in Telescope correlated to that request's batch AND trace.
import 'reflect-metadata';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type AgentObservation,
  type Entry,
  InMemoryStorageProvider,
  TelescopeModule,
  TelescopeService,
  type TraceContext,
  subscribeAgentObservations,
} from '@dudousxd/nestjs-telescope';
import { AiModule, AiService } from '@nestjs/ai';
import { FakeModel } from '@nestjs/ai/testing';
import { AuthenticationModule, TokenService } from '@nestjs/authentication';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import { Controller, Get, type INestApplication, Inject, Injectable } from '@nestjs/common';
import { InMemoryMailTransport, MailModule, MailTransport, Mailer } from '@nestjs/mail';
import { CircuitBreakerPolicy, RetryPolicy } from '@nestjs/resilience';
import { Test } from '@nestjs/testing';
import { Workflow, WorkflowClient, type WorkflowContext, WorkflowsModule } from '@nestjs/workflows';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { telescopeAiUsage } from './ai-usage.js';
import { officialWatchers } from './official-watchers.js';

const traceAls = new AsyncLocalStorage<TraceContext>();
let traceCounter = 0;

@Workflow('ship-order')
class ShipOrderWorkflow {
  async run(ctx: WorkflowContext, input: { orderId: string }) {
    const label = await ctx.step('label', () => `label-${input.orderId}`);
    return { label };
  }
}

@Policy()
class OrderPolicy {
  refund(_user: unknown): boolean {
    return false;
  }
}

class FailingTransport extends MailTransport {
  async send(): Promise<never> {
    throw new Error('SMTP down');
  }
}

@Injectable()
class Flows {
  constructor(
    @Inject(WorkflowClient) private readonly workflows: WorkflowClient,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(Mailer) private readonly mailer: Mailer,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  async resilience(): Promise<void> {
    let calls = 0;
    const retry = new RetryPolicy({ attempts: 2, backoff: () => 0, name: 'orders.fetch' });
    await retry.execute(() => {
      calls += 1;
      if (calls === 1) throw new Error('flaky');
      return 'ok';
    });
    const breaker = new CircuitBreakerPolicy({ name: 'payments' });
    breaker.trip();
    await breaker.execute(() => 'never').catch(() => undefined);
  }

  async workflow(): Promise<void> {
    await this.workflows.startAndWait(ShipOrderWorkflow, { orderId: 'o-1' });
  }

  async auth(): Promise<void> {
    const issued = (await this.tokens.issue('user-1', { method: 'password' })) as {
      refreshToken: string;
    };
    await this.tokens.refresh(issued.refreshToken);
    // A spent refresh token comes back: the family is revoked (`refresh-token-reused`).
    await this.tokens.refresh(issued.refreshToken).catch(() => undefined);
  }

  async mail(): Promise<void> {
    await this.mailer.send({ to: 'jane@example.com', subject: 'Welcome', text: 'hi' });
  }

  async generate(): Promise<void> {
    await this.ai.generateText({ prompt: 'hello', label: 'triage' });
  }
}

@Controller('flows')
class FlowsController {
  constructor(@Inject(Flows) private readonly flows: Flows) {}

  @Get('resilience')
  @Can.Anyone()
  async resilience() {
    await this.flows.resilience();
    return { ok: true };
  }

  @Get('workflow')
  @Can.Anyone()
  async workflow() {
    await this.flows.workflow();
    return { ok: true };
  }

  @Get('auth')
  @Can.Anyone()
  async auth() {
    await this.flows.auth();
    return { ok: true };
  }

  @Get('mail')
  @Can.Anyone()
  async mail() {
    await this.flows.mail();
    return { ok: true };
  }

  @Get('ai')
  @Can.Anyone()
  async ai() {
    await this.flows.generate();
    return { ok: true };
  }

  @Get('refund')
  @Can(OrderPolicy, 'refund')
  refund() {
    return { ok: true };
  }
}

describe('official channels + @nestjs/ai usage (e2e, real packages)', () => {
  let app: INestApplication;
  const storage = new InMemoryStorageProvider();
  const observations: AgentObservation[] = [];
  let unsubscribe: () => void = () => undefined;

  beforeAll(async () => {
    unsubscribe = subscribeAgentObservations((o) => observations.push(o));
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          storage,
          routes: false,
          watchers: officialWatchers(),
          traceContext: { current: () => traceAls.getStore() ?? null },
        }),
        WorkflowsModule.forRoot({ retry: false }),
        AuthenticationModule.forRoot({
          accessToken: { key: 'k'.repeat(32) },
          allowInMemoryStorage: true,
          globalGuard: false,
        }),
        AuthorizationModule.forRoot(),
        MailModule.forRoot({ transport: new InMemoryMailTransport(), from: 'app@example.com' }),
        AiModule.forRoot({
          models: {
            default: {
              model: new FakeModel(
                [
                  {
                    text: 'hi',
                    usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200 },
                  },
                ],
                { provider: 'fake', modelId: 'fake-1' },
              ),
              pricing: { input: 3, output: 15 },
            },
          },
          onUsage: telescopeAiUsage({ actor: () => 'user:1' }),
        }),
      ],
      controllers: [FlowsController],
      providers: [Flows, ShipOrderWorkflow, OrderPolicy],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use((_req: unknown, _res: unknown, next: () => void) => {
      traceCounter += 1;
      traceAls.enterWith({
        traceId: traceCounter.toString(16).padStart(32, 'a'),
        spanId: traceCounter.toString(16).padStart(16, 'b'),
      });
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    unsubscribe();
    await app?.close();
  });

  async function hit(path: string, status = 200): Promise<Entry[]> {
    await request(app.getHttpServer()).get(path).expect(status);
    await app.get(TelescopeService).flush();
    const requests = (await storage.get({ type: 'request', limit: 100 })).data;
    const req = requests.find((e) => (e.content as { uri?: string }).uri?.endsWith(path));
    expect(req, `request entry for ${path}`).toBeDefined();
    return storage.batch(req!.batchId);
  }

  function ofType(batch: Entry[], type: string): Entry[] {
    return batch.filter((e) => e.type === type);
  }

  function expectSameTrace(batch: Entry[], entries: Entry[]): void {
    const req = batch.find((e) => e.type === 'request')!;
    expect(req.traceId).toMatch(/^[0-9a-f]{32}$/);
    for (const e of entries) expect(e.traceId).toBe(req.traceId);
  }

  it('records @nestjs/resilience retries and breaker events in the request', async () => {
    const batch = await hit('/flows/resilience');
    const entries = ofType(batch, 'resilience');
    const events = entries.map((e) => (e.content as { event: string }).event);
    expect(events).toEqual(expect.arrayContaining(['retry', 'circuit-open', 'circuit-rejected']));
    const retry = entries.find((e) => (e.content as { event: string }).event === 'retry')!;
    expect(retry.content).toMatchObject({
      policy: 'orders.fetch',
      attempt: 1,
      error: { message: 'flaky' },
    });
    expect(retry.familyHash).toBe('retry:orders.fetch');
    const rejected = entries.find(
      (e) => (e.content as { event: string }).event === 'circuit-rejected',
    )!;
    expect(rejected.tags).toContain('failed');
    expectSameTrace(batch, entries);
  });

  it('records @nestjs/workflows lifecycle events', async () => {
    await request(app.getHttpServer()).get('/flows/workflow').expect(200);
    await app.get(TelescopeService).flush();
    const entries = (await storage.get({ type: 'workflow', limit: 100 })).data;
    const events = entries.map((e) => (e.content as { event: string }).event);
    expect(events).toEqual(
      expect.arrayContaining(['workflow-started', 'step-completed', 'workflow-completed']),
    );
    const step = entries.find((e) => (e.content as { event: string }).event === 'step-completed')!;
    expect(step.content).toMatchObject({ workflow: 'ship-order', step: 'label', attempt: 1 });
    expect(step.familyHash).toBe('ship-order');
    const done = entries.find(
      (e) => (e.content as { event: string }).event === 'workflow-completed',
    )!;
    expect(done.content).toMatchObject({ output: { label: 'label-o-1' } });
  });

  it('records @nestjs/authentication events, redacted', async () => {
    const batch = await hit('/flows/auth');
    const entries = ofType(batch, 'auth');
    const signIn = entries.find((e) => (e.content as { event: string }).event === 'sign-in')!;
    expect(signIn.content).toMatchObject({
      source: 'authentication',
      userId: 'user-1',
      method: 'password',
      tokenFamilyRef: expect.stringMatching(/^sha256:[0-9a-f]{12}$/),
    });
    expect(signIn.content).not.toHaveProperty('tokenFamilyId');
    const reused = entries.find(
      (e) => (e.content as { event: string }).event === 'refresh-token-reused',
    )!;
    expect(reused.tags).toContain('failed');
    expect((reused.content as { tokenFamilyRef: string }).tokenFamilyRef).toBe(
      (signIn.content as { tokenFamilyRef: string }).tokenFamilyRef,
    );
    expect(JSON.stringify(entries)).not.toMatch(/refreshToken|accessToken/);
    expectSameTrace(batch, entries);
  });

  it('records an @nestjs/authorization denial without the user object', async () => {
    const batch = await hit('/flows/refund', 401);
    const [denied] = ofType(batch, 'auth');
    expect(denied?.content).toMatchObject({
      source: 'authorization',
      event: 'denied',
      policy: 'OrderPolicy',
      ability: 'refund',
      reason: 'unauthenticated',
      handler: 'FlowsController.refund',
    });
    expect(denied?.content).not.toHaveProperty('user');
    expect(denied?.familyHash).toBe('denied:OrderPolicy.refund');
    expectSameTrace(batch, [denied!]);
  });

  it('records @nestjs/mail sends as mail entries', async () => {
    const batch = await hit('/flows/mail');
    const [mail] = ofType(batch, 'mail');
    expect(mail?.content).toMatchObject({
      mailer: '@nestjs/mail',
      to: ['jane@example.com'],
      subject: 'Welcome',
      status: 'sent',
      transport: 'InMemoryMailTransport',
      attempts: 1,
    });
    expectSameTrace(batch, [mail!]);
  });

  it('maps @nestjs/ai onUsage to a usage.recorded agent entry and the AI metrics', async () => {
    const before = observations.length;
    const batch = await hit('/flows/ai');
    const [usage] = ofType(batch, 'agent');
    expect(usage?.content).toMatchObject({
      event: 'usage.recorded',
      source: '@nestjs/ai',
      feature: 'triage',
      actorRef: 'user:1',
      modelId: 'fake-1',
      provider: 'fake',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      costSource: 'estimate',
    });
    expect((usage?.content as { costUsd: number }).costUsd).toBeGreaterThan(0);
    expectSameTrace(batch, [usage!]);
    const fresh = observations.slice(before);
    expect(fresh).toEqual([
      expect.objectContaining({
        kind: 'usage',
        feature: 'triage',
        model: 'fake-1',
        costSource: 'estimate',
      }),
    ]);
  });
});

describe('@nestjs/mail failure (e2e)', () => {
  it('records nestjs:mail:failed as a failed mail entry', async () => {
    const storage = new InMemoryStorageProvider();
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          storage,
          routes: false,
          watchers: officialWatchers(),
        }),
        MailModule.forRoot({
          transport: new FailingTransport(),
          from: 'app@example.com',
          retry: false,
        }),
      ],
    }).compile();
    const app = await moduleRef.createNestApplication().init();
    try {
      await expect(
        app.get(Mailer).send({ to: 'bob@example.com', subject: 'Oops', text: 'x' }),
      ).rejects.toThrow();
      await app.get(TelescopeService).flush();
      const [mail] = (await storage.get({ type: 'mail' })).data;
      expect(mail?.content).toMatchObject({ status: 'failed', to: ['bob@example.com'] });
      expect(mail?.tags).toContain('failed');
    } finally {
      await app.close();
    }
  });

  it('stops recording once the app is closed (watchers unregister)', async () => {
    const storage = new InMemoryStorageProvider();
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          storage,
          routes: false,
          watchers: officialWatchers(),
        }),
      ],
    }).compile();
    const app = await moduleRef.createNestApplication().init();
    await app.close();
    const breaker = new CircuitBreakerPolicy({ name: 'after-close' });
    breaker.trip();
    expect((await storage.get({ type: 'resilience' })).data).toHaveLength(0);
  });
});
