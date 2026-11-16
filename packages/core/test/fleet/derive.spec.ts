import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type CheckState,
  type InstanceRecord,
  deriveFleet,
  instanceStatus,
  normalizeHeartbeat,
  resolveFleetConfig,
  resolveVersion,
  restartLoopsOf,
} from '../../src/index.js';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const MIN = 60_000;

function instance(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    app: 'shop',
    instanceId: `i-${Math.random().toString(36).slice(2, 8)}`,
    host: 'web-1',
    pid: 1,
    version: 'v1',
    bootedAt: NOW - 60 * MIN,
    firstSeenAt: NOW - 60 * MIN,
    lastSeenAt: NOW - 5_000,
    state: 'ready',
    intervalMs: 15_000,
    checks: [],
    shipping: null,
    ...overrides,
  };
}

function check(overrides: Partial<CheckState> = {}): CheckState {
  return {
    name: 'redis',
    status: 'ok',
    message: null,
    since: NOW - 30 * MIN,
    checkedAt: NOW - 1000,
    durationMs: 2,
    critical: true,
    ...overrides,
  };
}

describe('instance states', () => {
  it('ready → up, starting and draining as reported', () => {
    expect(instanceStatus(instance(), NOW)).toBe('up');
    expect(instanceStatus(instance({ state: 'starting' }), NOW)).toBe('starting');
    expect(instanceStatus(instance({ state: 'draining' }), NOW)).toBe('draining');
  });

  it('gone after more than 3 missed intervals, whatever it last said', () => {
    expect(instanceStatus(instance({ lastSeenAt: NOW - 45_000 }), NOW)).toBe('up');
    expect(instanceStatus(instance({ lastSeenAt: NOW - 45_001 }), NOW)).toBe('gone');
    expect(instanceStatus(instance({ state: 'draining', lastSeenAt: NOW - 46_000 }), NOW)).toBe(
      'gone',
    );
    // Uses the instance's own interval, and a configurable count.
    expect(instanceStatus(instance({ intervalMs: 60_000, lastSeenAt: NOW - 100_000 }), NOW)).toBe(
      'up',
    );
    expect(instanceStatus(instance({ lastSeenAt: NOW - 20_000 }), NOW, 1)).toBe('gone');
  });

  it('counts per app, versions of live instances, uptime', () => {
    const [billing, shop] = deriveFleet(
      [
        instance({ host: 'web-1' }),
        instance({ host: 'web-2', state: 'starting', bootedAt: NOW - 10_000 }),
        instance({ host: 'web-3', state: 'draining' }),
        instance({ host: 'web-4', lastSeenAt: NOW - 10 * MIN, version: 'v0' }),
        instance({ app: 'billing', host: 'b-1' }),
      ],
      NOW,
    );
    expect(shop?.app).toBe('shop');
    expect(shop?.counts).toEqual({ up: 1, starting: 1, draining: 1, gone: 1 });
    expect(shop?.versions).toEqual([{ version: 'v1', instances: 3 }]);
    expect(shop?.instances.map((i) => i.status)).toEqual(['up', 'starting', 'draining', 'gone']);
    expect(shop?.instances[0]?.uptimeMs).toBe(60 * MIN);
    // A gone instance's uptime stops at its last heartbeat.
    expect(shop?.instances[3]?.uptimeMs).toBe(50 * MIN);
    expect(billing?.counts.up).toBe(1);
  });

  it('sums the live instances shipping stats', () => {
    const shipping = (buffered: number, dropped: number, lagMs: number) => ({
      buffered,
      dropped,
      sent: 10,
      failures: 0,
      lagMs,
      lastError: null,
    });
    const [app] = deriveFleet(
      [
        instance({ shipping: shipping(3, 1, 500) }),
        instance({ shipping: shipping(4, 2, 9000) }),
        instance({ shipping: shipping(100, 100, 1), lastSeenAt: NOW - 10 * MIN }),
      ],
      NOW,
    );
    expect(app?.shipping).toEqual({ buffered: 7, dropped: 3, maxLagMs: 9000 });
  });
});

describe('deploys', () => {
  it('is a version change across instances, with rollout progress', () => {
    const [app] = deriveFleet(
      [
        instance({ host: 'a', version: 'v1', bootedAt: NOW - 120 * MIN }),
        instance({ host: 'b', version: 'v1', bootedAt: NOW - 119 * MIN }),
        instance({ host: 'c', version: 'v2', bootedAt: NOW - 2 * MIN }),
        instance({
          host: 'd',
          version: 'v1',
          bootedAt: NOW - 119 * MIN,
          lastSeenAt: NOW - 3 * MIN,
        }),
      ],
      NOW,
    );
    expect(app?.deploys).toEqual([
      {
        version: 'v2',
        previous: 'v1',
        startedAt: NOW - 2 * MIN,
        live: 1,
        total: 3,
        progress: 1 / 3,
        complete: false,
      },
    ]);
  });

  it('completes when every live instance runs the new version; keeps the history', () => {
    const [app] = deriveFleet(
      [
        instance({
          host: 'a',
          version: 'v1',
          bootedAt: NOW - 300 * MIN,
          lastSeenAt: NOW - 100 * MIN,
        }),
        instance({
          host: 'a',
          version: 'v2',
          bootedAt: NOW - 100 * MIN,
          lastSeenAt: NOW - 50 * MIN,
        }),
        instance({ host: 'a', version: 'v3', bootedAt: NOW - 50 * MIN }),
        instance({ host: 'b', version: 'v3', bootedAt: NOW - 49 * MIN }),
      ],
      NOW,
    );
    expect(app?.deploys.map((d) => [d.previous, d.version, d.complete, d.progress])).toEqual([
      ['v1', 'v2', false, 0],
      ['v2', 'v3', true, 1],
    ]);
  });

  it('no deploy with one version', () => {
    expect(deriveFleet([instance(), instance({ host: 'b' })], NOW)[0]?.deploys).toEqual([]);
  });
});

describe('deploys and draining', () => {
  it('a draining host on the old version keeps the rollout incomplete', () => {
    const [app] = deriveFleet(
      [
        instance({ host: 'a', version: 'v1', bootedAt: NOW - 120 * MIN, state: 'draining' }),
        instance({ host: 'b', version: 'v2', bootedAt: NOW - 2 * MIN }),
      ],
      NOW,
    );
    expect(app?.deploys[0]).toMatchObject({ version: 'v2', live: 1, total: 2, complete: false });
  });

  it('with nothing running any more the rollout is over, not stuck at 0/0', () => {
    const gone = NOW - 30 * MIN;
    const [app] = deriveFleet(
      [
        instance({ host: 'a', version: 'v1', bootedAt: NOW - 120 * MIN, lastSeenAt: gone }),
        instance({ host: 'b', version: 'v2', bootedAt: NOW - 60 * MIN, lastSeenAt: gone }),
      ],
      NOW,
    );
    expect(app?.deploys[0]).toMatchObject({ live: 0, total: 0, progress: 1, complete: true });
  });
});

describe('restart loops', () => {
  it('flags a host that booted N times within M minutes', () => {
    const boots = [1, 3, 5].map((m) =>
      instance({ host: 'web-1', bootedAt: NOW - m * MIN, lastSeenAt: NOW - m * MIN + 20_000 }),
    );
    const [app] = deriveFleet([...boots, instance({ host: 'web-2' })], NOW);
    expect(app?.restartLoops).toEqual([
      { host: 'web-1', restarts: 3, since: NOW - 5 * MIN, lastBootAt: NOW - MIN },
    ]);
  });

  it('ignores boots outside the window and hosts under the count', () => {
    const records = [
      instance({ host: 'h', bootedAt: NOW - 2 * MIN }),
      instance({ host: 'h', bootedAt: NOW - 4 * MIN }),
      instance({ host: 'h', bootedAt: NOW - 30 * MIN }),
    ];
    expect(restartLoopsOf(records, NOW)).toEqual([]);
    expect(restartLoopsOf(records, NOW, { restarts: 2, withinMs: 5 * MIN })).toHaveLength(1);
  });

  it('is configured by fleet.restartLoop', () => {
    expect(
      resolveFleetConfig({ restartLoop: { restarts: 5, within: '30m' } }, true).restartLoop,
    ).toEqual({
      restarts: 5,
      withinMs: 30 * MIN,
    });
    expect(() => resolveFleetConfig({ restartLoop: { restarts: 1 } }, true)).toThrow(/2 or more/);
  });
});

describe('check incidents', () => {
  it('reports the worst status, the earliest since, and how many instances', () => {
    const [app] = deriveFleet(
      [
        instance({
          host: 'a',
          checks: [check({ status: 'down', since: NOW - 12 * MIN, message: 'OOM' })],
        }),
        instance({ host: 'b', checks: [check({ status: 'down', since: NOW - 10 * MIN })] }),
        instance({
          host: 'c',
          checks: [check(), check({ name: 'db', status: 'warn', since: NOW - MIN })],
        }),
        // A gone instance's checks do not count.
        instance({
          host: 'd',
          lastSeenAt: NOW - 60 * MIN,
          checks: [check({ name: 'db', status: 'down' })],
        }),
      ],
      NOW,
    );
    expect(app?.checks).toEqual([
      {
        name: 'redis',
        status: 'down',
        since: NOW - 12 * MIN,
        message: 'OOM',
        affected: 2,
        of: 3,
        critical: true,
      },
      {
        name: 'db',
        status: 'warn',
        since: NOW - MIN,
        message: null,
        affected: 1,
        of: 1,
        critical: true,
      },
    ]);
    expect(app?.instances.find((i) => i.host === 'c')?.health).toBe('warn');
  });
});

describe('heartbeat wire format', () => {
  const valid = {
    v: 1,
    instanceId: 'web-1-42-abcd',
    host: 'web-1',
    pid: 42,
    version: 'abc123',
    bootedAt: '2026-11-15T11:00:00.000Z',
    sentAt: '2026-11-15T12:00:00.000Z',
    state: 'ready',
    intervalMs: 15000,
    checks: [
      {
        name: 'redis',
        status: 'down',
        message: 'x',
        since: 1,
        checkedAt: 2,
        durationMs: 3,
        critical: true,
      },
    ],
    shipping: { buffered: 1, dropped: 2, sent: 3, failures: 0, lagMs: 10, lastError: null },
  };

  it('keeps a valid heartbeat', () => {
    expect(normalizeHeartbeat(valid)).toMatchObject({
      instanceId: 'web-1-42-abcd',
      state: 'ready',
    });
  });

  it('refuses junk and bounds what it keeps', () => {
    expect(normalizeHeartbeat({ ...valid, v: 2 })).toBeNull();
    expect(normalizeHeartbeat({ ...valid, state: 'zombie' })).toBeNull();
    expect(normalizeHeartbeat({ ...valid, instanceId: 'has space' })).toBeNull();
    expect(normalizeHeartbeat({ ...valid, bootedAt: 'never' })).toBeNull();
    const bounded = normalizeHeartbeat({
      ...valid,
      host: 'h'.repeat(1000),
      intervalMs: 10 ** 12,
      checks: Array.from({ length: 80 }, (_, i) => ({ name: `c${i}`, status: 'ok' })),
    });
    expect(bounded?.host).toHaveLength(255);
    expect(bounded?.intervalMs).toBe(3_600_000);
    expect(bounded?.checks).toHaveLength(50);
  });
});

describe('version', () => {
  it('from the configured value, a sha env var (cut to 12), else package.json', async () => {
    expect(await resolveVersion('1.2.3')).toBe('1.2.3');
    expect(await resolveVersion(() => 'fn')).toBe('fn');
    expect(await resolveVersion(null, undefined, { GIT_SHA: '0123456789abcdef0123' })).toBe(
      '0123456789ab',
    );
    expect(await resolveVersion(null, undefined, { RENDER_GIT_COMMIT: 'release-7' })).toBe(
      'release-7',
    );
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const pkg = (await import('../../package.json', { with: { type: 'json' } })).default as {
      version: string;
    };
    expect(await resolveVersion(null, root, {})).toBe(pkg.version);
    expect(await resolveVersion(null, '/nonexistent-telescope-root', {})).toBeNull();
  });
});
