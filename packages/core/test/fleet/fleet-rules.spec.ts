import { describe, expect, it } from 'vitest';
import {
  type AlertPayload,
  type AlertRule,
  type AlertsOptions,
  type CheckState,
  FleetRegistry,
  FleetRuleEvaluator,
  InMemoryStorageProvider,
  type InstanceHeartbeat,
  MemoryFleetStore,
  TelescopeAlerter,
  formatSlackMessage,
  resolveAlerts,
} from '../../src/index.js';

const quiet = { channels: [{ name: 'quiet', send: async () => {} }] };
const resolveConfig = (alerts: Partial<AlertsOptions> & { rules: AlertRule[] }) =>
  resolveAlerts({ ...quiet, ...alerts }) as NonNullable<ReturnType<typeof resolveAlerts>>;

/** The alerter as the fleet rules see it: `evaluateOnce()` runs one interval evaluation. */
function alerter(deps: ConstructorParameters<typeof TelescopeAlerter>[0]) {
  const service = new TelescopeAlerter(deps);
  return Object.assign(service, { evaluateOnce: () => service.evaluate() });
}

const MIN = 60_000;

function harness(rules: AlertRule[], cooldown = '1m') {
  let now = Date.parse('2026-11-15T12:00:00.000Z');
  const fleet = new FleetRegistry(new MemoryFleetStore(), { now: () => now });
  const sent: AlertPayload[] = [];
  const service = alerter({
    alerts: resolveConfig({
      rules,
      cooldown,
      channels: [{ name: 'test', acceptsResolved: true, send: async (p) => void sent.push(p) }],
    }),
    storage: new InMemoryStorageProvider(),
    instanceId: 'cp',
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
    fleet,
    sent,
    service,
    beat,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const states = (sent: AlertPayload[]) => sent.map((p) => `${p.status ?? 'firing'}:${p.fleet?.app}`);

describe('instances-up', () => {
  it('fires when an app has fewer than `below` up for `for`, resolves when they are back', async () => {
    const h = harness([{ type: 'instances-up', app: 'shop', below: 2, for: '1m' }]);
    await h.beat('shop', 'a');
    await h.beat('shop', 'b');
    await h.service.evaluateOnce();
    expect(h.sent).toEqual([]);

    // b stops beating: gone after 3 intervals; held for 1 minute before paging.
    h.advance(50_000);
    await h.beat('shop', 'a');
    await h.service.evaluateOnce();
    expect(h.sent).toEqual([]);
    h.advance(61_000);
    await h.beat('shop', 'a');
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop']);
    expect(h.sent[0]).toMatchObject({ value: 1, threshold: 2 });
    expect(h.sent[0]?.fleet?.detail).toBe('1 instance up (expected at least 2)');

    // Still down: deduped.
    await h.service.evaluateOnce();
    expect(h.sent).toHaveLength(1);

    await h.beat('shop', 'c');
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop', 'resolved:shop']);
  });

  it('pages when an app has none left (below: 1), and for an app never seen', async () => {
    const h = harness([
      { type: 'instances-up', below: 1, for: '0s' },
      { type: 'instances-up', app: 'ghost', below: 1, for: '0s' },
    ]);
    await h.beat('shop', 'a');
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:ghost']);
    h.advance(10 * MIN);
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:ghost', 'firing:shop']);
    expect(h.sent[1]?.fleet?.detail).toBe('no instance is up');
  });

  it('a rolling deploy shorter than `for` does not page', async () => {
    const h = harness([{ type: 'instances-up', app: 'shop', below: 1, for: '2m' }]);
    await h.beat('shop', 'a', { state: 'draining' });
    await h.service.evaluateOnce();
    h.advance(30_000);
    await h.beat('shop', 'b');
    await h.service.evaluateOnce();
    expect(h.sent).toEqual([]);
  });
});

describe('check-down', () => {
  const down = (since: number): CheckState => ({
    name: 'redis',
    status: 'down',
    message: 'OOM command not allowed',
    since,
    checkedAt: since,
    durationMs: 2,
    critical: true,
  });

  it('fires once the check has been down for `for`, per app and check; resolves when ok', async () => {
    const h = harness([{ type: 'check-down', check: 'redis', for: '2m' }]);
    const since = h.now();
    await h.beat('shop', 'a', { checks: [down(since)] });
    await h.service.evaluateOnce();
    expect(h.sent).toEqual([]);
    h.advance(3 * MIN);
    await h.beat('shop', 'a', { checks: [down(since)] });
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop']);
    expect(h.sent[0]?.fleet).toMatchObject({
      check: 'redis',
      detail: 'redis: down for 3 min on 1 of 1 instance (OOM command not allowed)',
    });
    expect(h.sent[0]?.value).toBe(180);

    await h.beat('shop', 'a', { checks: [{ ...down(since), status: 'ok', since: h.now() }] });
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop', 'resolved:shop']);
  });

  it('renders for Slack with the app, the check and the detail', async () => {
    const h = harness([{ type: 'check-down', for: '0s' }]);
    await h.beat('shop', 'a', { checks: [down(h.now() - 12 * MIN)] });
    await h.service.evaluateOnce();
    const slack = JSON.stringify(formatSlackMessage(h.sent[0] as AlertPayload));
    expect(slack).toContain('Health check down');
    expect(slack).toContain('redis: down for 12 min');
  });

  it('a sender clock ahead of ours reads as 0 s down, never negative', async () => {
    const h = harness([{ type: 'check-down', check: 'redis', for: '1m' }]);
    await h.beat('shop', 'a', { checks: [down(h.now() + 5 * MIN)] });
    const evaluator = new FleetRuleEvaluator(h.fleet);
    const [outcome] = await evaluator.evaluate(
      { type: 'check-down', check: 'redis', for: '1m' },
      '0',
      h.now(),
    );
    expect(outcome).toMatchObject({ crosses: false, value: 0 });
    expect(outcome?.fleet.detail).toMatch(/down for 1 s/);
    await h.service.evaluateOnce();
    expect(h.sent).toEqual([]);
  });
});

describe('restart-loop', () => {
  it('fires when a host keeps booting, resolves once it settles', async () => {
    const h = harness([{ type: 'restart-loop' }]);
    for (const [i, m] of [5, 3, 1].entries()) {
      await h.beat('shop', `crash-${i}`, {
        host: 'web-1',
        bootedAt: new Date(h.now() - m * MIN).toISOString(),
      });
    }
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop']);
    expect(h.sent[0]?.fleet).toMatchObject({ host: 'web-1' });
    expect(h.sent[0]?.fleet?.detail).toMatch(/web-1 restarted 3 times/);
    h.advance(20 * MIN);
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop', 'resolved:shop']);
  });

  it('two hosts looping at once page once each, and each resolves on its own', async () => {
    const h = harness([{ type: 'restart-loop' }]);
    const loop = async (host: string, minutesAgo: number[]) => {
      for (const [i, m] of minutesAgo.entries()) {
        await h.beat('shop', `${host}-${i}`, {
          host,
          bootedAt: new Date(h.now() - m * MIN).toISOString(),
        });
      }
    };
    await loop('web-1', [9, 8, 7]);
    await loop('web-2', [3, 2, 1]);
    await h.service.evaluateOnce();
    expect(h.sent.map((p) => `${p.status ?? 'firing'}:${p.fleet?.host}`).sort()).toEqual([
      'firing:web-1',
      'firing:web-2',
    ]);
    // web-1's boots leave the 10 min window first; web-2 keeps looping.
    h.advance(4 * MIN);
    await h.service.evaluateOnce();
    expect(h.sent.slice(2).map((p) => `${p.status ?? 'firing'}:${p.fleet?.host}`)).toEqual([
      'resolved:web-1',
    ]);
  });
});

describe('entries-dropped', () => {
  const shipping = (dropped: number) => ({
    buffered: 10_000,
    dropped,
    sent: 1,
    failures: 3,
    lagMs: 60_000,
    lastError: 'ECONNREFUSED',
  });

  it('fires when the instances dropped entries within the window, resolves when they stop', async () => {
    const h = harness([{ type: 'entries-dropped', window: '5m', threshold: 100 }]);
    await h.beat('shop', 'a', { shipping: shipping(1000) });
    await h.service.evaluateOnce();
    // A long-running process' first sample is a baseline, not a drop.
    expect(h.sent).toEqual([]);
    h.advance(MIN);
    await h.beat('shop', 'a', { shipping: shipping(1500) });
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop']);
    expect(h.sent[0]?.value).toBe(500);
    h.advance(6 * MIN);
    await h.beat('shop', 'a', { shipping: shipping(1500) });
    await h.service.evaluateOnce();
    h.advance(MIN);
    await h.beat('shop', 'a', { shipping: shipping(1500) });
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop', 'resolved:shop']);
  });

  it('a new process counts its drops whole while its boot is inside the window', async () => {
    const h = harness([{ type: 'entries-dropped', window: '5m', threshold: 100 }]);
    const bootedAt = new Date(h.now() - 30_000).toISOString();
    await h.beat('shop', 'fresh', { bootedAt, shipping: shipping(300) });
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop']);
    expect(h.sent[0]?.value).toBe(300);
    // No new drops, but they are still inside the window: it keeps firing (no flap).
    h.advance(MIN);
    await h.beat('shop', 'fresh', { bootedAt, shipping: shipping(300) });
    await h.service.evaluateOnce();
    expect(h.sent).toHaveLength(1);
    // Once the boot leaves the window the drops do too.
    h.advance(5 * MIN);
    await h.beat('shop', 'fresh', { bootedAt, shipping: shipping(300) });
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop', 'resolved:shop']);
  });
});

describe('config', () => {
  it('validates the fleet rules at boot', () => {
    expect(() => resolveConfig({ rules: [{ type: 'instances-up', below: 0 }] })).toThrow(/below/);
    expect(() => resolveConfig({ rules: [{ type: 'check-down', for: 'soon' }] })).toThrow(
      /Invalid duration/,
    );
    expect(() =>
      resolveConfig({ rules: [{ type: 'entries-dropped', window: '5m', threshold: 0 }] }),
    ).toThrow(/threshold/);
    expect(resolveConfig({ rules: [{ type: 'restart-loop' }] }).rules).toHaveLength(1);
  });

  it('without a fleet the fleet rules do nothing', async () => {
    const sent: AlertPayload[] = [];
    const service = alerter({
      alerts: resolveConfig({
        rules: [{ type: 'instances-up', app: 'x', below: 1, for: '0s' }],
        channels: [{ name: 't', send: async (p) => void sent.push(p) }],
      }),
      storage: new InMemoryStorageProvider(),
      instanceId: 'cp',
      droppedCount: () => 0,
      fleet: () => null,
    });
    await service.evaluateOnce();
    expect(sent).toEqual([]);
  });
});

describe('workers', () => {
  it('instances-up counts web instances: a live worker does not hide a web outage', async () => {
    const h = harness([{ type: 'instances-up', app: 'shop', below: 1, for: '0s' }]);
    await h.beat('shop', 'worker', { role: 'bullmq' });
    await h.service.evaluateOnce();
    // shop runs only a worker: it follows its workers (as before roles).
    expect(h.sent).toEqual([]);
    await h.beat('shop', 'web');
    h.advance(61_000);
    await h.beat('shop', 'worker', { role: 'bullmq' });
    await h.service.evaluateOnce();
    expect(states(h.sent)).toEqual(['firing:shop']);
    expect(h.sent[0]?.fleet?.detail).toBe('no instance is up');
  });

  it('instances-up per role, or every instance with *; without app only apps running the role', async () => {
    const h = harness([
      { type: 'instances-up', role: 'bullmq', below: 2, for: '0s' },
      { type: 'instances-up', role: '*', app: 'shop', below: 3, for: '0s' },
    ]);
    await h.beat('shop', 'web');
    await h.beat('shop', 'worker', { role: 'bullmq' });
    await h.beat('billing', 'web');
    await h.service.evaluateOnce();
    // billing runs no bullmq worker: not paged for it.
    expect(states(h.sent).sort()).toEqual(['firing:shop', 'firing:shop']);
    expect(h.sent.map((p) => p.fleet?.detail).sort()).toEqual([
      '1 bullmq instance up (expected at least 2)',
      '2 instances up (expected at least 3)',
    ]);
  });

  it('restart loops are per host and role, and name a worker role', async () => {
    const h = harness([{ type: 'restart-loop' }]);
    for (const id of ['w1', 'w2', 'w3']) {
      await h.beat('shop', id, {
        host: 'pod-1',
        role: 'bullmq',
        bootedAt: new Date(h.now() - MIN).toISOString(),
      });
    }
    // One web boot on the same host: not part of the worker's loop.
    await h.beat('shop', 'web', { host: 'pod-1', bootedAt: new Date(h.now() - MIN).toISOString() });
    await h.service.evaluateOnce();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.fleet?.detail).toMatch(/^pod-1 \(bullmq\) restarted 3 times/);
  });
});
