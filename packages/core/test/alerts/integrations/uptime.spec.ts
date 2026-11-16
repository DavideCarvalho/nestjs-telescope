import { Logger } from '@nestjs/common';
// packages/core/test/alerts/integrations/uptime.spec.ts
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { customChannel } from '../../../src/alerts/alert-channel.js';
import {
  type UptimeCheckState as CheckState,
  publishCheckStates,
  publishedCheckStates,
  uptimeHandler,
  uptimeResponse,
} from '../../../src/alerts/integrations/check-states.js';
import {
  HeartbeatMonitor,
  heartbeatRequests,
} from '../../../src/alerts/integrations/heartbeats.js';
import {
  StatusPageSync,
  componentStatuses,
  statusForKey,
} from '../../../src/alerts/integrations/status-pages.js';
import { TelescopeAlerter } from '../../../src/alerts/telescope-alerter.js';
import { InMemoryStorageProvider } from '../../../src/storage/in-memory-storage-provider.js';
import { fakeSleep, mockFetch } from './helpers.js';

const up = (name: string, app?: string): CheckState => ({
  name,
  status: 'ok',
  ...(app ? { app } : {}),
});
const down = (name: string, app?: string, message = 'boom'): CheckState => ({
  name,
  status: 'down',
  message,
  ...(app ? { app } : {}),
});

describe('heartbeat provider URLs', () => {
  it('healthchecks.io: ping, /fail, /start (query kept)', () => {
    const r = heartbeatRequests('healthchecks', 'https://hc-ping.com/uuid?rid=1', 'redis down');
    expect(r.ok.url).toBe('https://hc-ping.com/uuid?rid=1');
    expect(r.fail?.url).toBe('https://hc-ping.com/uuid/fail?rid=1');
    expect(r.fail?.body).toBe('redis down');
    expect(r.start?.url).toBe('https://hc-ping.com/uuid/start?rid=1');
  });

  it('Better Stack: GET ping, POST /fail', () => {
    const r = heartbeatRequests(
      'betterstack',
      'https://incidents.betterstack.com/api/v1/heartbeat/T',
      'x',
    );
    expect(r.ok).toMatchObject({ method: 'GET' });
    expect(r.fail?.url).toBe('https://incidents.betterstack.com/api/v1/heartbeat/T/fail');
  });

  it('Cronitor: state=complete|fail|run', () => {
    const r = heartbeatRequests('cronitor', 'https://cronitor.link/p/KEY/web', 'redis down');
    expect(r.ok.url).toBe('https://cronitor.link/p/KEY/web?state=complete');
    expect(r.fail?.url).toBe('https://cronitor.link/p/KEY/web?state=fail&message=redis+down');
    expect(r.start?.url).toBe('https://cronitor.link/p/KEY/web?state=run');
  });

  it('Uptime Kuma: status=up|down replaces the push URL params', () => {
    const r = heartbeatRequests(
      'uptime-kuma',
      'https://kuma.example/api/push/T?status=up&msg=OK&ping=',
      'db down',
    );
    expect(r.ok.url).toBe('https://kuma.example/api/push/T?status=up&msg=OK&ping=');
    expect(r.fail?.url).toBe('https://kuma.example/api/push/T?status=down&msg=db+down&ping=');
  });

  it('UptimeRobot and plain URLs have no fail signal unless given one', () => {
    expect(
      heartbeatRequests('uptimerobot', 'https://heartbeat.uptimerobot.com/X', '').fail,
    ).toBeNull();
    expect(heartbeatRequests('url', 'https://x/ok', '').fail).toBeNull();
    expect(heartbeatRequests('url', 'https://x/ok', '', 'https://x/fail').fail?.url).toBe(
      'https://x/fail',
    );
  });
});

describe('HeartbeatMonitor', () => {
  it('pings while healthy and sends /fail when a check is down', async () => {
    let states: CheckState[] = [up('redis'), up('postgres')];
    const { fetch, calls } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'healthchecks', url: 'https://hc-ping.com/u', every: '60s' }],
      source: () => states,
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ healthchecks: 'ok' });
    expect(calls[0]?.url).toBe('https://hc-ping.com/u');

    expect(await monitor.tick(30_000)).toEqual({}); // not due yet

    states = [up('postgres'), down('redis', undefined, 'OOM')];
    expect(await monitor.tick(60_000)).toEqual({ healthchecks: 'fail' });
    expect(calls[1]?.url).toBe('https://hc-ping.com/u/fail');
    expect(calls[1]?.body).toBe('redis down: OOM');
  });

  it('skips (no request) when unhealthy and the provider has no fail signal', async () => {
    const { fetch, calls } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'uptimerobot', url: 'https://heartbeat.uptimerobot.com/X' }],
      source: () => [down('redis')],
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ uptimerobot: 'skipped' });
    expect(calls).toHaveLength(0);
  });

  it("onUnhealthy: 'skip' lets the grace period run out instead of failing", async () => {
    const { fetch, calls } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'healthchecks', url: 'https://hc-ping.com/u', onUnhealthy: 'skip' }],
      source: () => [down('redis')],
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ healthchecks: 'skipped' });
    expect(calls).toHaveLength(0);
  });

  it('a degraded check still pings', async () => {
    const { fetch } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'betterstack', url: 'https://b.example/hb/T' }],
      source: () => [{ name: 'disk', status: 'warn' }],
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ betterstack: 'ok' });
  });

  it('a failing source is treated as unhealthy', async () => {
    const { fetch, calls } = mockFetch();
    const logs: string[] = [];
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'betterstack', url: 'https://b.example/hb/T' }],
      source: () => {
        throw new Error('checks exploded');
      },
      fetch,
      logger: (m) => logs.push(m),
    });
    expect(await monitor.tick(0)).toEqual({ betterstack: 'fail' });
    expect(calls[0]?.url).toBe('https://b.example/hb/T/fail');
    expect(logs[0]).toContain('checks exploded');
  });

  it('per-app URLs follow each app, and a silent app is not vouched for', async () => {
    const { fetch, calls } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [
        {
          provider: 'uptime-kuma',
          apps: {
            checkout: 'https://kuma.example/api/push/A',
            billing: 'https://kuma.example/api/push/B',
            ghost: 'https://kuma.example/api/push/C',
          },
        },
      ],
      source: () => [up('redis', 'checkout'), down('postgres', 'billing')],
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({
      'uptime-kuma:checkout': 'ok',
      'uptime-kuma:billing': 'fail',
      'uptime-kuma:ghost': 'fail',
    });
    const byToken = Object.fromEntries(
      calls.map((c) => [new URL(c.url).pathname, new URL(c.url).searchParams.get('status')]),
    );
    expect(byToken).toEqual({
      '/api/push/A': 'up',
      '/api/push/B': 'down',
      '/api/push/C': 'down',
    });
  });

  it("a malformed URL is that target's error: tick() resolves and the others still ping", async () => {
    const { fetch, calls } = mockFetch();
    const logs: string[] = [];
    const monitor = new HeartbeatMonitor({
      heartbeats: [
        { provider: 'cronitor', url: 'not a url', name: 'bad', signalStart: true },
        { provider: 'uptime-kuma', apps: { a: '::nope::' }, name: 'kuma' },
        { provider: 'healthchecks', url: 'https://hc-ping.com/good', name: 'good' },
      ],
      source: () => [],
      fetch,
      logger: (m) => logs.push(m),
    });
    await expect(monitor.tick(0)).resolves.toEqual({ bad: 'error', 'kuma:a': 'error', good: 'ok' });
    expect(calls.map((c) => c.url)).toEqual(['https://hc-ping.com/good']);
    expect(logs).toEqual([
      "Telescope heartbeat 'bad' failed: invalid ping URL",
      "Telescope heartbeat 'kuma:a' failed: invalid ping URL",
    ]);
    expect(logs.join()).not.toContain('not a url');
  });

  it("an unknown provider is that target's error, never a rejected tick", async () => {
    const { fetch, calls } = mockFetch();
    const logs: string[] = [];
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'nope' as never, url: 'https://x.example/hb', signalStart: true }],
      source: () => [],
      fetch,
      logger: (m) => logs.push(m),
    });
    await expect(monitor.tick(0)).resolves.toEqual({ nope: 'error' });
    expect(calls).toHaveLength(0);
    expect(logs).toEqual(["Telescope heartbeat 'nope' failed: unknown heartbeat provider"]);
  });

  it('`checks` limits which checks count', async () => {
    const { fetch } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'url', url: 'https://x/ok', checks: ['postgres'] }],
      source: () => [up('postgres'), down('mailer')],
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ url: 'ok' });
  });

  it('sends the start signal once and warns once per failing target, without the URL', async () => {
    const { fetch, calls } = mockFetch([{ status: 200 }, { status: 500 }]);
    const { sleep } = fakeSleep();
    const logs: string[] = [];
    const monitor = new HeartbeatMonitor({
      heartbeats: [
        {
          provider: 'healthchecks',
          url: 'https://hc-ping.com/SECRET-UUID',
          signalStart: true,
          every: '1s',
        },
      ],
      source: () => [],
      fetch,
      sleep,
      logger: (m) => logs.push(m),
    });
    await monitor.tick(0);
    await monitor.tick(1000);
    expect(calls[0]?.url).toBe('https://hc-ping.com/SECRET-UUID/start');
    expect(calls.filter((c) => c.url.endsWith('/start'))).toHaveLength(1);
    expect(logs).toEqual(["Telescope heartbeat 'healthchecks' failed: HTTP 500"]);
  });
});

describe('status page mapping', () => {
  const states = [
    up('redis', 'checkout'),
    down('postgres', 'checkout'),
    up('redis', 'billing'),
    { name: 'disk', status: 'warn' as const, app: 'billing' },
  ];

  it('resolves check, app:, app/check and * keys', () => {
    expect(statusForKey(states, 'redis')).toBe('up');
    expect(statusForKey(states, 'postgres')).toBe('down');
    expect(statusForKey(states, 'app:billing')).toBe('degraded');
    expect(statusForKey(states, 'checkout/redis')).toBe('up');
    expect(statusForKey(states, '*')).toBe('down');
    expect(statusForKey(states, 'nope')).toBeNull();
  });

  it('several keys on one component take the worst', () => {
    const map = componentStatuses(states, {
      redis: 'C1',
      'app:billing': 'C1',
      'checkout/redis': 'C2',
      nope: 'C3',
    });
    expect([...map]).toEqual([
      ['C1', 'degraded'],
      ['C2', 'up'],
    ]);
  });
});

describe('StatusPageSync', () => {
  it('Atlassian Statuspage: PATCHes only changed components, opens and resolves an incident', async () => {
    let states: CheckState[] = [up('redis'), up('postgres')];
    const { fetch, calls } = mockFetch([{ status: 200, json: { id: 'inc-1' } }]);
    let now = 0;
    const sync = new StatusPageSync({
      statusPages: [
        {
          provider: 'statuspage',
          apiKey: 'SP-KEY',
          pageId: 'PAGE',
          components: { redis: 'cRedis', postgres: 'cPg' },
          incidents: true,
          every: '30s',
        },
      ],
      source: () => states,
      fetch,
      now: () => now,
    });
    await sync.tick();
    expect(calls.map((c) => [c.method, c.url, (c.json as any).component?.status])).toEqual([
      ['PATCH', 'https://api.statuspage.io/v1/pages/PAGE/components/cRedis', 'operational'],
      ['PATCH', 'https://api.statuspage.io/v1/pages/PAGE/components/cPg', 'operational'],
    ]);
    expect(calls[0]?.headers.authorization).toBe('OAuth SP-KEY');

    now = 30_000;
    await sync.tick(); // nothing changed
    expect(calls).toHaveLength(2);

    now = 60_000;
    states = [up('redis'), down('postgres', undefined, 'timeout')];
    await sync.tick();
    expect(calls.slice(2).map((c) => [c.method, c.url])).toEqual([
      ['PATCH', 'https://api.statuspage.io/v1/pages/PAGE/components/cPg'],
      ['POST', 'https://api.statuspage.io/v1/pages/PAGE/incidents'],
    ]);
    expect((calls[2]!.json as any).component.status).toBe('major_outage');
    expect((calls[3]!.json as any).incident).toMatchObject({
      status: 'investigating',
      component_ids: ['cPg'],
      components: { cPg: 'major_outage' },
      body: 'Affected: postgres down: timeout',
    });

    now = 90_000;
    states = [up('redis'), up('postgres')];
    await sync.tick();
    expect(calls.slice(4).map((c) => [c.method, c.url])).toEqual([
      ['PATCH', 'https://api.statuspage.io/v1/pages/PAGE/components/cPg'],
      ['PATCH', 'https://api.statuspage.io/v1/pages/PAGE/incidents/inc-1'],
    ]);
    expect((calls[5]!.json as any).incident).toMatchObject({
      status: 'resolved',
      components: { cPg: 'operational' },
    });
  });

  it('folds components that fail after the incident opened into it and into the resolve', async () => {
    let states: CheckState[] = [down('redis'), up('postgres')];
    const { fetch, calls } = mockFetch([{ status: 200, json: { id: 'inc-9' } }]);
    let now = 0;
    const sync = new StatusPageSync({
      statusPages: [
        {
          provider: 'statuspage',
          apiKey: 'k',
          pageId: 'P',
          components: { redis: 'cRedis', postgres: 'cPg' },
          incidents: true,
          every: '30s',
        },
      ],
      source: () => states,
      fetch,
      now: () => now,
    });
    await sync.tick(); // opens with cRedis
    now = 30_000;
    states = [down('redis'), down('postgres')];
    await sync.tick();
    const update = calls.find(
      (c) =>
        c.url.endsWith('/incidents/inc-9') && (c.json as any).incident.status === 'investigating',
    );
    expect((update?.json as any).incident).toMatchObject({
      component_ids: ['cRedis', 'cPg'],
      components: { cRedis: 'major_outage', cPg: 'major_outage' },
    });
    now = 60_000;
    await sync.tick(); // unchanged: no further update
    const before = calls.length;
    now = 90_000;
    states = [up('redis'), up('postgres')];
    await sync.tick();
    const resolve = calls.slice(before).find((c) => c.url.endsWith('/incidents/inc-9'));
    expect((resolve?.json as any).incident).toMatchObject({
      status: 'resolved',
      components: { cRedis: 'operational', cPg: 'operational' },
    });
  });

  it('Instatus: posts an incident update when another component fails', async () => {
    let states: CheckState[] = [down('redis'), up('postgres')];
    const { fetch, calls } = mockFetch([{ status: 200, json: { id: 'i-1' } }]);
    let now = 0;
    const sync = new StatusPageSync({
      statusPages: [
        {
          provider: 'instatus',
          apiKey: 'k',
          pageId: 'P',
          components: { redis: 'cR', postgres: 'cP' },
          incidents: true,
          every: '30s',
        },
      ],
      source: () => states,
      fetch,
      now: () => now,
    });
    await sync.tick();
    now = 30_000;
    states = [down('redis'), down('postgres')];
    await sync.tick();
    const update = calls.at(-1);
    expect(update?.url).toBe('https://api.instatus.com/v1/P/incidents/i-1/incident-updates');
    expect(update?.json).toMatchObject({ status: 'INVESTIGATING', components: ['cR', 'cP'] });
  });

  it('Instatus: PUTs component status and opens/resolves an incident', async () => {
    let states: CheckState[] = [down('api', 'checkout')];
    const { fetch, calls } = mockFetch([{ status: 200, json: { id: 'i9' } }]);
    let now = 0;
    const sync = new StatusPageSync({
      statusPages: [
        {
          provider: 'instatus',
          apiKey: 'IN',
          pageId: 'P',
          components: { 'app:checkout': 'cmp' },
          incidents: true,
        },
      ],
      source: () => states,
      fetch,
      now: () => now,
    });
    await sync.tick();
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: 'https://api.instatus.com/v2/P/components/cmp',
    });
    expect(calls[0]?.json).toEqual({ status: 'MAJOROUTAGE' });
    expect(calls[1]?.url).toBe('https://api.instatus.com/v1/P/incidents');
    expect(calls[1]?.json).toMatchObject({ status: 'INVESTIGATING', components: ['cmp'] });

    now = 60_000;
    states = [up('api', 'checkout')];
    await sync.tick();
    expect(calls[2]?.json).toEqual({ status: 'OPERATIONAL' });
    expect(calls[3]?.url).toBe('https://api.instatus.com/v1/P/incidents/i9/incident-updates');
    expect(calls[3]?.json).toMatchObject({
      status: 'RESOLVED',
      statuses: [{ id: 'cmp', status: 'OPERATIONAL' }],
    });
  });

  it('Better Stack: opens a status report and resolves it with a status update', async () => {
    let states: CheckState[] = [up('redis')];
    const { fetch, calls } = mockFetch([{ status: 201, json: { data: { id: '55' } } }]);
    let now = 0;
    const sync = new StatusPageSync({
      statusPages: [
        {
          provider: 'betterstack',
          apiToken: 'BS',
          statusPageId: 'SP',
          components: { redis: '777' },
        },
      ],
      source: () => states,
      fetch,
      now: () => now,
    });
    await sync.tick();
    expect(calls).toHaveLength(0); // healthy: nothing to report

    now = 60_000;
    states = [down('redis')];
    await sync.tick();
    expect(calls[0]?.url).toBe(
      'https://incidents.betterstack.com/api/v2/status-pages/SP/status-reports',
    );
    expect(calls[0]?.json).toMatchObject({
      report_type: 'manual',
      affected_resources: [{ status_page_resource_id: '777', status: 'downtime' }],
    });

    now = 120_000;
    await sync.tick(); // unchanged
    expect(calls).toHaveLength(1);

    now = 180_000;
    states = [up('redis')];
    await sync.tick();
    expect(calls[1]?.url).toBe(
      'https://incidents.betterstack.com/api/v2/status-pages/SP/status-reports/55/status-updates',
    );
    expect(calls[1]?.json).toMatchObject({
      affected_resources: [{ status_page_resource_id: '777', status: 'resolved' }],
    });
  });

  it('a failed sync retries on the next timer tick, a successful one waits a full `every`', async () => {
    const { fetch, calls } = mockFetch([{ status: 500 }, { status: 200 }]);
    let now = 0;
    const sync = new StatusPageSync({
      statusPages: [
        {
          provider: 'statuspage',
          apiKey: 'K',
          pageId: 'P',
          components: { redis: 'c' },
          every: '60s',
        },
      ],
      source: () => [down('redis')],
      fetch,
      retries: 0,
      now: () => now,
      logger: () => {},
    });
    await sync.tick(); // 500
    now = 15_000; // next timer tick, well before `every`
    await sync.tick(); // retried → 200
    expect(calls).toHaveLength(2);
    now = 30_000;
    await sync.tick(); // synced 15s ago: not due
    expect(calls).toHaveLength(2);
  });

  it('leaves pages alone when health is unknown, and retries a failed update next tick', async () => {
    let fail = true;
    const { fetch, calls } = mockFetch([{ status: 500 }, { status: 500 }, { status: 200 }]);
    const { sleep } = fakeSleep();
    let now = 0;
    const logs: string[] = [];
    const sync = new StatusPageSync({
      statusPages: [
        { provider: 'statuspage', apiKey: 'K', pageId: 'P', components: { redis: 'c' } },
      ],
      source: () => {
        if (fail) throw new Error('no idea');
        return [down('redis')];
      },
      fetch,
      sleep,
      now: () => now,
      logger: (m) => logs.push(m),
    });
    await sync.tick();
    expect(calls).toHaveLength(0);
    fail = false;
    now = 60_000;
    await sync.tick(); // 500 twice (1 retry) → logged, not remembered
    now = 120_000;
    await sync.tick(); // retried and sent
    expect(calls).toHaveLength(3);
    expect(logs.filter((l) => l.includes("status page 'statuspage'"))).toEqual([
      "Telescope status page 'statuspage' sync failed: HTTP 500",
    ]);
  });
});

describe('uptime handler (pull)', () => {
  afterEach(() => publishCheckStates(null));

  it('maps up → 200, degraded → 200 (configurable), down → 503', () => {
    expect(uptimeResponse([up('a')]).statusCode).toBe(200);
    expect(uptimeResponse([{ name: 'a', status: 'warn' }]).statusCode).toBe(200);
    expect(
      uptimeResponse([{ name: 'a', status: 'warn' }], { degradedStatusCode: 503 }).statusCode,
    ).toBe(503);
    expect(uptimeResponse([down('a')]).statusCode).toBe(503);
    expect(uptimeResponse([up('a', 'x')], { app: 'y' }).body.status).toBe('down');
  });

  it('requires the token (query or header) and shows details only then', async () => {
    const handler = uptimeHandler({ source: () => [up('redis'), down('pg')], token: 'tok' });
    expect((await handler({})).statusCode).toBe(401);
    expect((await handler({ query: { token: 'nope' } })).statusCode).toBe(401);

    const viaQuery = await handler({ query: { token: 'tok' } });
    expect(viaQuery.statusCode).toBe(503);
    expect(viaQuery.body.status).toBe('down');
    expect(viaQuery.body.checks).toHaveLength(2);

    const viaHeader = await handler({ headers: { 'x-telescope-health-token': 'tok' } });
    expect(viaHeader.statusCode).toBe(503);
  });

  it('an open endpoint answers status only; ?app scopes; the published source is the default', async () => {
    publishCheckStates(() => [up('redis', 'checkout'), down('pg', 'billing')]);
    const result = await uptimeHandler()({ query: { app: 'checkout' } });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ status: 'up', app: 'checkout' });
    expect(result.body.checks).toBeUndefined();
  });

  it('is a liveness probe with no source, and answers 503 when the source throws', async () => {
    expect(publishedCheckStates()).toBeNull();
    expect((await uptimeHandler()({})).statusCode).toBe(200);
    const failing = uptimeHandler({
      source: () => {
        throw new Error('db gone');
      },
    });
    expect((await failing({})).statusCode).toBe(503);
  });
});

describe('check-state vocabulary', () => {
  it('a non-critical down check keeps the heartbeat green but still moves its component', async () => {
    const { fetch } = mockFetch();
    const states: CheckState[] = [up('postgres'), { ...down('mailer'), critical: false }];
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'url', url: 'https://x/ok' }],
      source: () => states,
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ url: 'ok' });
    expect(statusForKey(states, 'mailer')).toBe('down');
    expect(uptimeResponse(states).statusCode).toBe(200);
  });

  it('`unknown` (not run yet) neither fails a heartbeat nor moves a component', async () => {
    const states: CheckState[] = [{ name: 'redis', status: 'unknown' }];
    const { fetch } = mockFetch();
    const monitor = new HeartbeatMonitor({
      heartbeats: [{ provider: 'url', url: 'https://x/ok' }],
      source: () => states,
      fetch,
    });
    expect(await monitor.tick(0)).toEqual({ url: 'ok' });
    expect(statusForKey(states, 'redis')).toBeNull();
  });
});

describe('wired through the TelescopeAlerter', () => {
  afterEach(() => {
    publishCheckStates(null);
    vi.unstubAllGlobals();
  });

  it('start() runs heartbeats from the published source; stop() stops them', async () => {
    const { fetch, calls } = mockFetch();
    vi.stubGlobal('fetch', fetch);
    publishCheckStates(() => [down('redis')]);
    const alerter = new TelescopeAlerter({
      alerts: {
        channels: [customChannel(async () => {})],
        dashboardUrl: null,
        intervalMs: 60_000,
        cooldownMs: 0,
        rules: [],
        geoLookup: null,
        heartbeats: [{ provider: 'healthchecks', url: 'https://hc-ping.com/uuid' }],
      },
      storage: new InMemoryStorageProvider(),
      instanceId: 'web-1',
      droppedCount: () => 0,
      logger: new Logger('test'),
    });
    alerter.start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    alerter.stop();
    expect(calls[0]?.url).toBe('https://hc-ping.com/uuid/fail');
    expect(calls[0]?.body).toBe('redis down: boom');
  });
});
