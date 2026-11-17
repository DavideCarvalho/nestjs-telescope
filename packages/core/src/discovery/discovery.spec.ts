// Units of service discovery: config, the directory and its global contract, the rewrite rules,
// the map a control plane builds from its fleet (liveness, newest URL, token scope), the long poll,
// and the tenant's snapshot.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InstanceRecord } from '../fleet/derive.js';
import { normalizeHeartbeat } from '../fleet/heartbeat.js';
import { readSnapshot, writeSnapshot } from './client.js';
import { resolveDiscovery } from './config.js';
import {
  DISCOVERY_SLOT,
  type DiscoveryContract,
  type DiscoveryMap,
  ServiceDirectory,
  publishDirectory,
} from './directory.js';
import { DiscoveryError, installFetchRewrite, isAppHost, rewriteTarget } from './rewrite.js';
import { DiscoveryPublisher, buildDiscoveryMap, discoveryScopeOf } from './server.js';

const NOW = 1_000_000;

function instance(
  over: Partial<InstanceRecord> & { app: string; instanceId: string },
): InstanceRecord {
  return {
    host: 'h',
    pid: 1,
    version: null,
    bootedAt: NOW - 60_000,
    firstSeenAt: NOW - 60_000,
    lastSeenAt: NOW - 1000,
    state: 'ready',
    intervalMs: 15_000,
    checks: [],
    shipping: null,
    url: `https://${over.app}.internal`,
    ...over,
  };
}

describe('discovery config', () => {
  it('reads the static map and refuses what cannot be a host or a URL', () => {
    const config = resolveDiscovery({ apps: { Billing: 'http://localhost:3334/api/' } });
    expect(config.apps).toEqual({ billing: 'http://localhost:3334/api' });
    expect(config.passthrough.has('localhost')).toBe(true);
    expect(resolveDiscovery(false).enabled).toBe(false);
    expect(() => resolveDiscovery({ apps: { 'billing.v2': 'http://x' } })).toThrow(/one DNS label/);
    expect(() => resolveDiscovery({ apps: { billing: 'ftp://x' } })).toThrow(/http\(s\) URL/);
    expect(() => resolveDiscovery({ apps: { billing: 'http://u:p@x' } })).toThrow(/http\(s\) URL/);
    expect(() => resolveDiscovery({ apps: { billing: 'http://x/?token=1' } })).toThrow(
      /query or hash/,
    );
    expect(() => resolveDiscovery({ apps: { billing: 'http://x/#a' } })).toThrow(/query or hash/);
    expect(() => resolveDiscovery({ apps: { '12345': 'http://x' } })).toThrow(/not all digits/);
    expect(() => resolveDiscovery({ apps: { __proto__x: 'http://x' } })).not.toThrow();
    expect(() =>
      resolveDiscovery({ apps: JSON.parse('{"__proto__":"http://x"}') as Record<string, string> }),
    ).toThrow(/one DNS label/);
  });

  it('carries the app URL in a heartbeat, refusing credentials', () => {
    const base = {
      v: 1,
      instanceId: 'i-1',
      state: 'ready',
      bootedAt: new Date().toISOString(),
      sentAt: new Date().toISOString(),
    };
    expect(normalizeHeartbeat({ ...base, url: 'https://billing.internal/' })?.url).toBe(
      'https://billing.internal',
    );
    expect(normalizeHeartbeat({ ...base, url: 'https://u:p@billing.internal' })?.url).toBeNull();
    expect(normalizeHeartbeat(base)?.url).toBeNull();
  });
});

describe('the directory', () => {
  it('resolves static first, then live apps, and down apps unless failFast', () => {
    const directory = new ServiceDirectory({ billing: 'http://localhost:3334' });
    directory.update({
      version: 'v1',
      apps: {
        billing: { url: 'https://billing.internal', live: 2 },
        search: { url: 'https://search.internal', live: 1 },
        mail: { url: 'https://mail.internal', live: 0 },
      },
    });
    expect(directory.resolve('BILLING')).toBe('http://localhost:3334');
    expect(directory.resolve('search')).toBe('https://search.internal');
    expect(directory.resolve('mail')).toBe('https://mail.internal');
    expect(directory.resolve('nope')).toBeUndefined();
    expect(directory.appOf('https://search.internal/x')).toBe('search');
    expect(directory.appOf('http://localhost:3334')).toBe('billing');
    const strict = new ServiceDirectory({}, { failFast: true });
    strict.update({ version: 'v1', apps: { mail: { url: 'https://mail.internal', live: 0 } } });
    expect(strict.resolve('mail')).toBeUndefined();
  });

  it('never lets an app name reach an object prototype', () => {
    const directory = new ServiceDirectory();
    directory.update(
      JSON.parse(
        '{"version":"v1","apps":{"__proto__":{"url":"http://evil:1","live":1},"billing":{"url":"http://b:1","live":1}}}',
      ) as DiscoveryMap,
    );
    expect(directory.resolve('__proto__')).toBeUndefined();
    expect(directory.resolve('constructor')).toBeUndefined();
    expect(directory.resolve('toString')).toBeUndefined();
    expect(directory.resolve('billing')).toBe('http://b:1');
    expect(Object.keys(directory.map?.apps ?? {})).toEqual(['billing']);
    const map = buildDiscoveryMap(
      [
        instance({ app: '__proto__', instanceId: 'p' }),
        instance({ app: '12345', instanceId: 'n' }),
      ],
      '*',
      NOW,
      3,
    );
    expect(Object.keys(map.apps)).toEqual([]);
  });

  it('publishes the contract on the Aviary slot and announces changes', () => {
    const directory = new ServiceDirectory();
    const unpublish = publishDirectory(directory);
    const contract = (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT] as DiscoveryContract;
    expect(DISCOVERY_SLOT).toBe(Symbol.for('@dudousxd/aviary:discovery'));
    let calls = 0;
    const unsubscribe = contract.subscribe(() => {
      calls += 1;
    });
    directory.update({ version: 'v1', apps: { billing: { url: 'http://b:1', live: 1 } } });
    directory.update({ version: 'v1', apps: {} });
    expect(calls).toBe(1);
    expect(contract.resolve('billing')).toBe('http://b:1');
    unsubscribe();
    unpublish();
    expect((globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT]).toBeUndefined();
  });
});

describe('the rewrite', () => {
  const directory = new ServiceDirectory({ billing: 'https://billing.internal/v1' });
  directory.update({ version: 'v1', apps: { mail: { url: 'https://mail.internal', live: 0 } } });
  const options = { passthrough: new Set(['localhost', 'minio']), failFast: false };

  it('rewrites a single-label app name, prefixing its base path', () => {
    expect(rewriteTarget(directory, options, 'http://billing/invoices')).toEqual({
      origin: 'https://billing.internal',
      basePath: '/v1',
      app: 'billing',
    });
    expect(rewriteTarget(directory, options, 'http://mail')?.origin).toBe('https://mail.internal');
  });

  it('never touches a dotted host, an IP, localhost, a passthrough, or an unknown name by default', () => {
    for (const url of [
      'http://billing.internal/x',
      'http://10.0.0.1/x',
      'http://[::1]:3000/x',
      'http://localhost:3000/x',
      'http://minio:9000/x',
      'http://nosuchapp/x',
      'ftp://billing/x',
    ]) {
      expect(rewriteTarget(directory, options, url), url).toBeNull();
    }
    expect(isAppHost('billing', options.passthrough)).toBe(true);
    expect(isAppHost('12345', options.passthrough)).toBe(false);
  });

  it('fails an unknown name with strict, and a down app with failFast', () => {
    expect(() => rewriteTarget(directory, { ...options, strict: true }, 'http://billng/x')).toThrow(
      DiscoveryError,
    );
    expect(() => rewriteTarget(directory, { ...options, strict: true }, 'http://billng/x')).toThrow(
      /app billng is not registered/,
    );
    expect(rewriteTarget(directory, { ...options, strict: true }, 'http://minio:9000')).toBeNull();
    expect(() => rewriteTarget(directory, { ...options, failFast: true }, 'http://mail/x')).toThrow(
      /no live instance/,
    );
  });
});

describe('the control plane map', () => {
  it('lists apps by their newest live URL, with live counts', () => {
    const map = buildDiscoveryMap(
      [
        instance({
          app: 'billing',
          instanceId: 'a',
          url: 'https://old.internal',
          lastSeenAt: NOW - 2000,
        }),
        instance({
          app: 'billing',
          instanceId: 'b',
          url: 'https://new.internal',
          lastSeenAt: NOW - 500,
        }),
        // Gone (no heartbeat for 3 intervals): counted out, its URL never wins over a live one.
        instance({
          app: 'billing',
          instanceId: 'c',
          url: 'https://gone.internal',
          lastSeenAt: NOW - 120_000,
        }),
        instance({ app: 'mail', instanceId: 'm', lastSeenAt: NOW - 120_000 }),
        instance({ app: 'nourl', instanceId: 'n', url: null }),
        instance({ app: 'bad.name', instanceId: 'x' }),
      ],
      '*',
      NOW,
      3,
    );
    expect(map.apps).toEqual({
      billing: { url: 'https://new.internal', live: 2 },
      mail: { url: 'https://mail.internal', live: 0 },
    });
    expect(map.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is scoped by the token', () => {
    expect(discoveryScopeOf({ tenant: 'shop' })).toBe('*');
    expect(discoveryScopeOf({ tenant: 'shop', capabilities: ['telescope:discovery'] })).toBe('*');
    expect(discoveryScopeOf({ tenant: 'shop', capabilities: ['telescope:ingest'] })).toBeNull();
    const scope = discoveryScopeOf({
      tenant: 'shop',
      capabilities: ['telescope:ingest', 'telescope:discovery:billing'],
    });
    const instances = [
      instance({ app: 'billing', instanceId: 'b' }),
      instance({ app: 'mail', instanceId: 'm' }),
    ];
    expect(Object.keys(buildDiscoveryMap(instances, scope ?? '*', NOW, 3).apps)).toEqual([
      'billing',
    ]);
    expect(buildDiscoveryMap(instances, scope ?? '*', NOW, 3).version).not.toBe(
      buildDiscoveryMap(instances, '*', NOW, 3).version,
    );
  });

  it('holds a caller until the map changes', async () => {
    const instances: InstanceRecord[] = [instance({ app: 'billing', instanceId: 'b' })];
    const publisher = new DiscoveryPublisher({
      instances: async () => instances,
      derive: { goneAfterIntervals: 3 },
      tickMs: 10_000,
      now: () => NOW,
    });
    const first = await publisher.wait('*', null, 10_000);
    const held = publisher.wait('*', first.version, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(publisher.pending).toBe(1);
    instances.push(instance({ app: 'search', instanceId: 's' }));
    publisher.poke();
    const next = await held;
    expect(Object.keys(next.apps)).toEqual(['billing', 'search']);
    expect(next.version).not.toBe(first.version);

    const abort = new AbortController();
    const hungUp = publisher.wait('*', next.version, 10_000, abort.signal);
    abort.abort();
    expect((await hungUp).version).toBe(next.version);
    expect(publisher.pending).toBe(0);
    await publisher.close();
  });
});

describe('the snapshot', () => {
  it('is read back only for its own scope', async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'telescope-discovery-'));
    const path = join(dir, 'snap.json');
    const map = { version: 'v1', apps: { billing: { url: 'http://b:1', live: 1 } } };
    await writeSnapshot(path, map, 'cp#shop');
    expect(readSnapshot(path, 'cp#shop')).toEqual(map);
    expect(readSnapshot(path, 'cp#billing')).toBeNull();
    expect(readSnapshot(join(dir, 'missing.json'), 'cp#shop')).toBeNull();
  });
});

describe('installing the rewrite', () => {
  /** A composable dispatcher, as undici's is: `compose` returns a new one wrapping this. */
  interface Fake {
    name: string;
    compose(...interceptors: unknown[]): Fake;
  }
  function fake(name: string): Fake {
    return { name, compose: () => fake(`${name}+`) };
  }

  it('restores what it was composed onto last, keeping layers added in between', async () => {
    const slot = globalThis as Record<symbol, unknown>;
    const keys = [Symbol.for('undici.globalDispatcher.2'), Symbol.for('undici.globalDispatcher.1')];
    const saved = keys.map((key) => slot[key]);
    const key = keys[0] as symbol;
    try {
      slot[keys[1] as symbol] = undefined;
      slot[key] = fake('base');
      const rewrite = await installFetchRewrite(new ServiceDirectory(), {
        passthrough: new Set(),
        failFast: false,
      });
      // Another library composes on top during boot; telescope goes back on top.
      const other = fake('other');
      slot[key] = other;
      rewrite?.reassert();
      expect((slot[key] as Fake).name).toBe('other+');
      rewrite?.uninstall();
      expect(slot[key]).toBe(other);
    } finally {
      keys.forEach((k, i) => {
        slot[k] = saved[i];
      });
    }
  });
});

describe('DiscoveryClient with a looked-up control plane URL', () => {
  it('polls the resolved URL and looks it up again after a 404', async () => {
    const { DiscoveryClient } = await import('./client.js');
    const { ServiceDirectory } = await import('./directory.js');
    const { ServerUrl } = await import('../topology/server-url.js');
    let lookups = 0;
    const server = new ServerUrl(async () => (lookups++ === 0 ? 'http://old/t' : 'http://new/t'));
    const asked: string[] = [];
    const client = new DiscoveryClient({
      url: server,
      token: 'tok',
      partition: 'shop',
      directory: new ServiceDirectory({}),
      snapshotPath: join(mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'disc-')), 'map.json'),
      fetch: async (input) => {
        const url = String(input);
        asked.push(url.split('?')[0] as string);
        return url.startsWith('http://old')
          ? new Response(null, { status: 404 })
          : new Response(JSON.stringify({ version: 'v1', apps: {} }), { status: 200 });
      },
    });
    expect(await client.pollOnce(10)).toBe(false);
    expect(await client.pollOnce(10)).toBe(true);
    expect(asked).toEqual(['http://old/t/api/discovery', 'http://new/t/api/discovery']);
  });
});
