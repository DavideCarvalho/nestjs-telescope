// The fleet through the alert integrations: fleet rules route by severity / channels like every
// rule, their clears are `status: 'resolved'` payloads that close the right incident, and the
// fleet's health-check states drive heartbeats, status pages and `uptimeHandler()`.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { titleOf } from '../../src/alerts/integrations/incident.js';
import {
  type AlertChannel,
  type AlertPayload,
  type AlertRule,
  FleetRegistry,
  InMemoryStorageProvider,
  type InstanceHeartbeat,
  MemoryFleetStore,
  TelescopeAlerter,
  TelescopeFleet,
  TelescopeModule,
  checks,
  incidentKey,
  pagerDutyChannel,
  publishCheckStates,
  publishedCheckStates,
  resolveAlerts,
  severityOf,
  uptimeHandler,
} from '../../src/index.js';

const MIN = 60_000;

function harness(rules: AlertRule[], channels: AlertChannel[]) {
  let now = Date.parse('2026-11-16T12:00:00.000Z');
  const fleet = new FleetRegistry(new MemoryFleetStore(), { now: () => now });
  const alerter = new TelescopeAlerter({
    alerts: resolveAlerts({ rules, channels, cooldown: '1m' }) as NonNullable<
      ReturnType<typeof resolveAlerts>
    >,
    storage: new InMemoryStorageProvider(),
    instanceId: 'cp-pod-1',
    droppedCount: () => 0,
    fleet: () => fleet,
    now: () => now,
  });
  const beat = (app: string, id: string, overrides: Partial<InstanceHeartbeat> = {}) =>
    fleet.beat(app, {
      v: 1,
      instanceId: id,
      host: id,
      pid: 1,
      version: 'v1',
      bootedAt: new Date(now - 60 * MIN).toISOString(),
      sentAt: new Date(now).toISOString(),
      state: 'ready',
      intervalMs: 15_000,
      checks: [],
      shipping: null,
      ...overrides,
    });
  return {
    alerter,
    beat,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

function collector(name: string, extra: Partial<AlertChannel> = {}) {
  const sent: AlertPayload[] = [];
  const channel: AlertChannel = { name, send: async (p) => void sent.push(p), ...extra };
  return { channel, sent };
}

const down = (since: number) => ({
  name: 'redis',
  status: 'down' as const,
  message: 'OOM',
  since,
  checkedAt: since,
  durationMs: 1,
  critical: true,
});

describe('fleet rules through the alert integrations', () => {
  it('default severities route with minSeverity; `channels` narrows a rule', async () => {
    const pager = collector('pager', { minSeverity: 'critical', acceptsResolved: true });
    const chat = collector('chat', { acceptsResolved: true });
    const h = harness(
      [
        { type: 'instances-up', app: 'shop', below: 1, for: '0s' },
        { type: 'entries-dropped', window: '5m', channels: ['chat'] },
      ],
      [pager.channel, chat.channel],
    );
    await h.beat('billing', 'b-1', {
      shipping: { buffered: 0, dropped: 3, sent: 1, failures: 0, lagMs: 0, lastError: null },
      bootedAt: new Date(h.now() - MIN).toISOString(),
    });
    await h.alerter.evaluate();
    // instances-up (critical) pages; entries-dropped (warning) only reaches `chat`.
    expect(pager.sent.map((p) => [p.rule.type, severityOf(p)])).toEqual([
      ['instances-up', 'critical'],
    ]);
    expect(chat.sent.map((p) => p.rule.type).sort()).toEqual(['entries-dropped', 'instances-up']);
    expect(titleOf(pager.sent[0] as AlertPayload)).toBe('[critical] shop: no instance is up');
  });

  it('a clear is one `status: resolved` payload with the incident key of its firing', async () => {
    const pager = collector('pager', { acceptsResolved: true });
    const slack = collector('slack'); // no acceptsResolved: firing only
    const h = harness(
      [{ type: 'check-down', check: 'redis', for: '1m' }],
      [pager.channel, slack.channel],
    );
    await h.beat('shop', 'a', { checks: [down(h.now() - 5 * MIN)] });
    await h.beat('billing', 'b', { checks: [down(h.now() - 5 * MIN)] });
    await h.alerter.evaluate();
    expect(pager.sent.map((p) => p.status ?? 'firing')).toEqual(['firing', 'firing']);
    const keys = pager.sent.map(incidentKey);
    // One incident per app and check, never the reporting pod's.
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toMatch(/^telescope:(shop|billing):check-down:1m:redis:redis$/);

    await h.beat('shop', 'a', { checks: [{ ...down(h.now()), status: 'ok' }] });
    await h.beat('billing', 'b', { checks: [down(h.now() - 6 * MIN)] });
    await h.alerter.evaluate();
    const resolved = pager.sent.filter((p) => p.status === 'resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.fleet).toMatchObject({ app: 'shop', check: 'redis' });
    expect(incidentKey(resolved[0] as AlertPayload)).toBe(keys.find((k) => k.includes(':shop:')));
    expect(slack.sent.every((p) => p.status === undefined)).toBe(true);
  });

  it('two check-down rules on different checks are two incidents', () => {
    const payload = (check: string): AlertPayload => ({
      rule: { type: 'check-down', check, for: '1m' },
      value: 60,
      threshold: 60,
      firedAt: '2026-11-16T12:00:00.000Z',
      instanceId: 'cp',
      fleet: { app: 'shop', detail: 'x' },
    });
    expect(incidentKey(payload('redis'))).not.toBe(incidentKey(payload('db')));
  });

  it('a looping host is its own incident, keyed by host', async () => {
    const pager = collector('pager', { acceptsResolved: true });
    const h = harness([{ type: 'restart-loop' }], [pager.channel]);
    for (let i = 0; i < 3; i++) {
      await h.beat('shop', `w-${i}`, {
        host: 'worker-0',
        bootedAt: new Date(h.now() - i * MIN).toISOString(),
      });
    }
    await h.alerter.evaluate();
    expect(pager.sent).toHaveLength(1);
    expect(incidentKey(pager.sent[0] as AlertPayload)).toBe('telescope:shop:restart-loop:worker-0');
    expect(severityOf(pager.sent[0] as AlertPayload)).toBe('error');
  });

  it('PagerDuty gets trigger then resolve with the same dedup_key', async () => {
    const bodies: { event_action: string; dedup_key: string }[] = [];
    const pager = pagerDutyChannel({
      routingKey: 'rk',
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 202 });
      },
    });
    const h = harness([{ type: 'instances-up', app: 'shop', below: 1, for: '0s' }], [pager]);
    await h.alerter.evaluate();
    await h.beat('shop', 'a');
    await h.alerter.evaluate();
    expect(bodies.map((b) => b.event_action)).toEqual(['trigger', 'resolve']);
    expect(bodies[0]?.dedup_key).toBe(bodies[1]?.dedup_key);
  });
});

describe('the fleet publishes its check states', () => {
  const apps: INestApplication[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    publishCheckStates(null);
  });

  async function boot(options: Parameters<typeof TelescopeModule.forRoot>[0]) {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ storage: new InMemoryStorageProvider(), ...options })],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    apps.push(app);
    await app.init();
    return app;
  }

  it('per app, with an `instances` check, for heartbeats, status pages and uptimeHandler()', async () => {
    const app = await boot({ fleet: { app: 'ops' } });
    const fleet = app.get(TelescopeFleet);
    const now = new Date().toISOString();
    const hb = (id: string, checks: InstanceHeartbeat['checks']): InstanceHeartbeat => ({
      v: 1,
      instanceId: id,
      host: id,
      pid: 1,
      version: 'v1',
      bootedAt: now,
      sentAt: now,
      state: 'ready',
      intervalMs: 15_000,
      checks,
      shipping: null,
    });
    await fleet.heartbeat('shop', hb('s-1', [down(Date.now())]));
    await fleet.heartbeat('shop', hb('s-2', [{ ...down(Date.now()), status: 'ok' }]));
    await fleet.heartbeat('billing', hb('b-1', []));
    const states = await publishedCheckStates()?.();
    expect(states?.filter((s) => s.app === 'shop')).toEqual([
      {
        name: 'instances',
        app: 'shop',
        status: 'ok',
        message: '2 of 2 instances up or starting',
        critical: true,
      },
      expect.objectContaining({ name: 'redis', app: 'shop', status: 'down', message: 'OOM' }),
    ]);
    const uptime = uptimeHandler();
    expect((await uptime({ query: { app: 'shop' } })).statusCode).toBe(503);
    expect((await uptime({ query: { app: 'billing' } })).statusCode).toBe(200);
    expect((await uptime({ query: { app: 'nope' } })).statusCode).toBe(503);
  });

  it('without a fleet, a standalone app with `checks` publishes its own; nothing configured publishes nothing', async () => {
    await boot({ checks: [checks.custom('db', () => ({ status: 'ok' }))] });
    const states = await publishedCheckStates()?.();
    expect(states?.map((s) => [s.name, s.status])).toEqual([['db', 'ok']]);
    await apps.splice(0)[0]?.close();
    expect(publishedCheckStates()).toBeNull();
    await boot({});
    expect(publishedCheckStates()).toBeNull();
  });
});
