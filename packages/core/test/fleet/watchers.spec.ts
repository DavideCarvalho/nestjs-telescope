import { describe, expect, it } from 'vitest';
import { consoleWatchers, fleetWatchers } from '../../src/fleet/watchers.js';
import {
  InstanceReporter,
  getTenantWatchers,
  normalizeHeartbeat,
  normalizeWatchers,
  registerTenantWatchers,
} from '../../src/index.js';

const at = 1_000_000;
const instance = (app: string, watchers?: string[], lastSeenAt = at) => ({
  app,
  lastSeenAt,
  ...(watchers !== undefined ? { watchers } : {}),
});

describe('normalizeWatchers', () => {
  it('dedupes, sorts, drops invalid names and bounds the list', () => {
    expect(normalizeWatchers(['query', 'job', 'query', 'bad name', 7, ''])).toEqual([
      'job',
      'query',
    ]);
    expect(normalizeWatchers(Array.from({ length: 100 }, (_, i) => `w${i}`))).toHaveLength(64);
    expect(normalizeWatchers(undefined)).toBeUndefined();
    expect(normalizeWatchers('query')).toBeUndefined();
  });

  it('a heartbeat keeps its watchers; one without them stays without (an older sender)', () => {
    const base = {
      v: 1,
      instanceId: 'a',
      state: 'ready',
      bootedAt: '2026-01-01',
      sentAt: '2026-01-01',
    };
    expect(normalizeHeartbeat({ ...base, watchers: ['query', 'request'] })?.watchers).toEqual([
      'query',
      'request',
    ]);
    expect(normalizeHeartbeat(base)).not.toHaveProperty('watchers');
  });

  it("the reporter sends the process's watchers, read on every beat", async () => {
    let watchers = ['request'];
    const reporter = new InstanceReporter({
      intervalMs: 1000,
      host: 'h',
      version: async () => null,
      watchers: () => watchers,
      send: () => {},
    });
    expect((await reporter.build()).watchers).toEqual(['request']);
    watchers = ['request', 'query'];
    expect((await reporter.build()).watchers).toEqual(['query', 'request']);
    const silent = new InstanceReporter({
      intervalMs: 1000,
      host: 'h',
      version: async () => null,
      send: () => {},
    });
    expect(await silent.build()).not.toHaveProperty('watchers');
  });
});

describe('fleetWatchers', () => {
  it('is the union of what the apps in view report', () => {
    expect(
      fleetWatchers({
        instances: [instance('shop', ['query', 'request']), instance('billing', ['job'])],
        since: 0,
        own: null,
      }),
    ).toEqual(['job', 'query', 'request']);
  });

  it('adds the own list when given', () => {
    expect(
      fleetWatchers({ instances: [instance('shop', ['query'])], since: 0, own: ['request'] }),
    ).toEqual(['query', 'request']);
  });

  it('is unknown when an app in view never said, or when nothing is known', () => {
    expect(
      fleetWatchers({
        instances: [instance('shop', ['query']), instance('old')],
        since: 0,
        own: ['request'],
      }),
    ).toBeNull();
    expect(fleetWatchers({ instances: [], since: 0, own: null })).toBeNull();
  });

  it("ignores an app's silent instances once one of them reports (an old process after an upgrade)", () => {
    expect(
      fleetWatchers({
        instances: [instance('shop'), instance('shop', ['query'])],
        since: 0,
        own: null,
      }),
    ).toEqual(['query']);
  });

  it('leaves out instances last seen before `since`', () => {
    expect(
      fleetWatchers({
        instances: [instance('shop', ['query']), instance('old', undefined, at - 10)],
        since: at - 5,
        own: null,
      }),
    ).toEqual(['query']);
  });
});

describe('consoleWatchers', () => {
  const input = {
    controlPlane: true,
    apps: null,
    selfApp: 'ops',
    since: 0,
    own: () => ['request'],
  };

  it('outside a control plane: undefined (the own list stands)', async () => {
    expect(
      await consoleWatchers({ ...input, controlPlane: false, instances: null }),
    ).toBeUndefined();
  });

  it('on a control plane without the fleet: unknown', async () => {
    expect(await consoleWatchers({ ...input, instances: null })).toBeNull();
  });

  it('on a control plane: the instances of the apps in view, plus its own for every app', async () => {
    const seen: (readonly string[] | null)[] = [];
    const instances = async (apps: readonly string[] | null) => {
      seen.push(apps);
      return [instance('ops', ['schedule']), instance('shop', ['query'])].filter(
        (row) => apps === null || apps.includes(row.app),
      );
    };
    expect(await consoleWatchers({ ...input, instances })).toEqual(['query', 'request']);
    expect(await consoleWatchers({ ...input, apps: ['shop'], instances })).toEqual(['query']);
    expect(await consoleWatchers({ ...input, apps: [], instances })).toBeNull();
    expect(seen).toEqual([null, ['shop'], []]);
  });

  it('a fleet store that fails: unknown', async () => {
    expect(
      await consoleWatchers({
        ...input,
        instances: async () => {
          throw new Error('down');
        },
      }),
    ).toBeNull();
  });

  it('the watchers it runs for its tenants count for every app in view', async () => {
    // durable's watcher records the tenants' workflow steps here; no tenant instance reports it.
    const instances = async () => [instance('shop', ['query', 'request'])];
    expect(
      await consoleWatchers({
        ...input,
        apps: ['shop'],
        instances,
        forTenants: () => ['durable'],
      }),
    ).toEqual(['durable', 'query', 'request']);
  });

  it('tenant watchers do not turn an unknown answer into a list', async () => {
    const instances = async () => [instance('shop')];
    expect(
      await consoleWatchers({
        ...input,
        apps: ['shop'],
        instances,
        forTenants: () => ['durable'],
      }),
    ).toBeNull();
  });
});

describe('registerTenantWatchers', () => {
  it('adds to the runtime list until its last holder releases', () => {
    const first = registerTenantWatchers(['durable']);
    const second = registerTenantWatchers(['durable']);
    expect(getTenantWatchers()).toContain('durable');
    first();
    first();
    expect(getTenantWatchers()).toContain('durable');
    second();
    expect(getTenantWatchers()).not.toContain('durable');
  });
});
