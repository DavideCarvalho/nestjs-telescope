import { describe, expect, it } from 'vitest';
import { HealthChecks, checks, redisMemory, summarizeChecks } from '../../src/index.js';

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('health checks', () => {
  it('reuses a result for cacheFor (default 30s), then runs again', async () => {
    const time = clock();
    let runs = 0;
    const set = new HealthChecks(
      [checks.custom('stripe', async () => ({ status: runs++ === 0 ? 'ok' : 'down' }))],
      { now: time.now },
    );
    expect((await set.run())[0]?.status).toBe('ok');
    time.advance(29_000);
    expect((await set.run())[0]?.status).toBe('ok');
    expect(runs).toBe(1);
    time.advance(2_000);
    const [state] = await set.run();
    expect(runs).toBe(2);
    expect(state?.status).toBe('down');
    expect(state?.since).toBe(time.now());
  });

  it('shares one run between concurrent callers (single-flight)', async () => {
    let runs = 0;
    let release: () => void = () => {};
    const set = new HealthChecks([
      checks.custom('slow', async () => {
        runs += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: 'ok' };
      }),
    ]);
    const a = set.run();
    const b = set.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
  });

  it('a throw or a timeout is down, with one line', async () => {
    const set = new HealthChecks([
      checks.custom('boom', () => {
        throw new Error('connection\n refused');
      }),
      checks.custom('hang', () => new Promise(() => {}), { timeout: 20 }),
    ]);
    const [boom, hang] = await set.run();
    expect(boom).toMatchObject({ status: 'down', message: 'connection refused' });
    expect(hang).toMatchObject({ status: 'down', message: 'timed out after 20 ms' });
  });

  it('keeps `since` while the status holds', async () => {
    const time = clock();
    const set = new HealthChecks(
      [checks.custom('x', () => ({ status: 'warn' }), { cacheFor: 1 })],
      {
        now: time.now,
      },
    );
    const first = (await set.run())[0];
    time.advance(10);
    const second = (await set.run())[0];
    expect(second?.since).toBe(first?.since);
  });

  it('down on a critical check is down overall; a non-critical one only warns', () => {
    const state = (name: string, status: 'ok' | 'down', critical: boolean) => ({
      name,
      status,
      message: null,
      since: 0,
      checkedAt: 1,
      durationMs: 1,
      critical,
    });
    expect(summarizeChecks([state('a', 'ok', true), state('b', 'down', false)]).status).toBe(
      'warn',
    );
    expect(summarizeChecks([state('a', 'down', true)]).status).toBe('down');
    expect(summarizeChecks([state('a', 'ok', true)]).status).toBe('ok');
  });

  it('refuses two checks with one name, and anything that is not a check', () => {
    expect(
      () =>
        new HealthChecks([
          checks.custom('a', () => ({ status: 'ok' })),
          checks.custom('a', () => ({ status: 'ok' })),
        ]),
    ).toThrow(/two checks/);
    expect(() => new HealthChecks([{} as never])).toThrow(/checks.custom/);
  });
});

describe('checks.redis()', () => {
  function redis(options: { setFails?: boolean; info?: string } = {}) {
    const calls: string[] = [];
    return {
      calls,
      client: {
        ping: async () => calls.push('ping'),
        set: async () => {
          calls.push('set');
          if (options.setFails)
            throw new Error("OOM command not allowed when used memory > 'maxmemory'");
        },
        info: async () => options.info ?? 'used_memory:100\r\nmaxmemory:0\r\n',
      },
    };
  }

  it('pings and writes a short-lived key', async () => {
    const r = redis();
    const [state] = await new HealthChecks([checks.redis({ client: r.client })]).run();
    expect(state?.status).toBe('ok');
    expect(r.calls).toEqual(['ping', 'set']);
  });

  it('a Redis at maxmemory that refuses writes is down (it still answers PING)', async () => {
    const [state] = await new HealthChecks([
      checks.redis({ client: redis({ setFails: true }).client }),
    ]).run();
    expect(state?.status).toBe('down');
    expect(state?.message).toContain('OOM');
  });

  it('warns at 90% of maxmemory', async () => {
    const r = redis({ info: 'used_memory:95\r\nmaxmemory:100\r\n' });
    const [state] = await new HealthChecks([checks.redis({ client: () => r.client })]).run();
    expect(state).toMatchObject({ status: 'warn', meta: { usedMemory: 95, maxMemory: 100 } });
    expect(redisMemory('used_memory:1\nmaxmemory:2')).toEqual({ used: 1, max: 2 });
    expect(redisMemory('nothing')).toBeNull();
  });
});

describe('checks.terminus()', () => {
  it('maps an @nestjs/terminus indicator: up is ok, down or a throw is down', async () => {
    const [up, down, thrown] = await new HealthChecks([
      checks.terminus('db', async () => ({ db: { status: 'up' } })),
      checks.terminus('disk', async () => ({ disk: { status: 'down', message: 'full' } })),
      checks.terminus('api', async () => {
        throw new Error('api check failed');
      }),
    ]).run();
    expect(up?.status).toBe('ok');
    expect(down).toMatchObject({ status: 'down', message: 'full' });
    expect(thrown).toMatchObject({ status: 'down', message: 'api check failed' });
  });
});
