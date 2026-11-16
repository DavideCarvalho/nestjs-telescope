import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import {
  TELESCOPE_INGEST_CAPABILITY,
  TELESCOPE_RELAY_CAPABILITY,
  canRelayFor,
  createIngestHandler,
  ingestHttpStatus,
  relayScope,
} from './ingest.js';
import { hmacTenantVerifier, signTenantToken } from './tenant-auth.js';
import {
  MAX_FUTURE_SKEW_MS,
  MAX_INGEST_ENTRIES,
  ingestBatch,
  parseIngestBatch,
  resolveCreatedAt,
} from './wire.js';

const SECRET = 'telescope-secret';
const NOW = Date.parse('2026-11-16T12:00:00.000Z');

function entry(id: string, tags: string[] = [], createdAt = new Date(NOW - 1_000)): Entry {
  return {
    id,
    batchId: `batch-${id}`,
    type: 'request',
    familyHash: null,
    content: { uri: `/${id}` },
    tags,
    sequence: 1,
    durationMs: 3,
    origin: 'http',
    instanceId: 'pod-1',
    traceId: null,
    spanId: null,
    createdAt,
  };
}

/** A body as it arrives over the wire (JSON round trip). */
function wire(entries: Entry[]): unknown {
  return JSON.parse(JSON.stringify(ingestBatch(entries, new Date(NOW))));
}

function setup(overrides: Partial<Parameters<typeof createIngestHandler>[0]> = {}) {
  const stored: Entry[] = [];
  const handler = createIngestHandler({
    verifyTenant: hmacTenantVerifier(SECRET),
    store: async (entries) => {
      stored.push(...entries);
    },
    existing: async (ids) => new Set(stored.filter((e) => ids.includes(e.id)).map((e) => e.id)),
    now: () => NOW,
    ...overrides,
  });
  return { stored, handler };
}

describe('createIngestHandler', () => {
  it('stores entries tagged with the app from the token, never from the body', async () => {
    const { stored, handler } = setup();
    const outcome = await handler({
      token: signTenantToken('shop', SECRET),
      // The sender claims another app with its own tag: dropped.
      body: wire([entry('e1', ['app:billing', 'user:1'])]),
    });
    expect(outcome).toEqual({
      status: 'stored',
      app: 'shop',
      stored: 1,
      duplicate: 0,
      relayed: 0,
      rejected: 0,
      apps: ['shop'],
    });
    expect(stored[0]?.tags).toEqual(['user:1', 'app:shop']);
    expect(stored[0]?.createdAt).toEqual(new Date(NOW - 1_000));
    expect(stored[0]?.id).toBe('e1');
  });

  it('refuses a missing, tampered or foreign-secret token', async () => {
    const { stored, handler } = setup();
    const body = wire([entry('e1')]);
    for (const token of [
      undefined,
      '',
      'shop',
      `${signTenantToken('shop', SECRET)}x`,
      signTenantToken('shop', 'other'),
    ]) {
      expect(await handler({ token, body })).toEqual({ status: 'unauthenticated' });
    }
    expect(stored).toHaveLength(0);
  });

  it('answers unavailable (retried) when the verifier throws', async () => {
    const { handler } = setup({
      verifyTenant: () => {
        throw new Error('idp down');
      },
    });
    const outcome = await handler({ token: 't', body: wire([entry('e1')]) });
    expect(outcome.status).toBe('unavailable');
    expect(ingestHttpStatus(outcome)).toBe(503);
  });

  it('requires telescope:ingest when the token lists capabilities', async () => {
    const without = setup({ verifyTenant: hmacTenantVerifier(SECRET, ['durable:run']) });
    const token = signTenantToken('shop', SECRET);
    expect((await without.handler({ token, body: wire([entry('e1')]) })).status).toBe('forbidden');
    const scoped = setup({
      verifyTenant: hmacTenantVerifier(SECRET, [TELESCOPE_INGEST_CAPABILITY]),
    });
    expect((await scoped.handler({ token, body: wire([entry('e1')]) })).status).toBe('stored');
  });

  it('stores a redelivered batch once, and an entry id once per app', async () => {
    const { stored, handler } = setup();
    const token = signTenantToken('shop', SECRET);
    const body = wire([entry('e1'), entry('e2')]);
    await handler({ token, body });
    expect(await handler({ token, body })).toMatchObject({ stored: 0, duplicate: 2 });
    // Same entries in a new batch (a resend after a restart): still once.
    expect(await handler({ token, body: wire([entry('e1'), entry('e3')]) })).toMatchObject({
      stored: 1,
      duplicate: 1,
    });
    expect(stored.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('never overwrites an entry the store holds, even one of another app', async () => {
    const { stored, handler } = setup();
    await handler({ token: signTenantToken('billing', SECRET), body: wire([entry('shared')]) });
    const outcome = await handler({
      token: signTenantToken('shop', SECRET),
      body: wire([entry('shared', ['evil'])]),
    });
    expect(outcome).toMatchObject({ status: 'stored', stored: 0, duplicate: 1 });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tags).toEqual(['app:billing']);
  });

  it('refuses malformed batches without storing anything', async () => {
    const { stored, handler } = setup();
    const token = signTenantToken('shop', SECRET);
    const good = wire([entry('e1')]) as { entries: unknown[] };
    const bad: unknown[] = [
      null,
      { ...good, v: 2 },
      { ...good, id: 'has space' },
      { ...good, entries: [{ ...(good.entries[0] as object), tags: 'x' }] },
      { ...good, entries: [{ ...(good.entries[0] as object), id: '' }] },
      { ...good, entries: Array.from({ length: MAX_INGEST_ENTRIES + 1 }, () => good.entries[0]) },
    ];
    for (const body of bad) {
      const outcome = await handler({ token, body });
      expect(outcome.status).toBe('invalid');
      expect(ingestHttpStatus(outcome)).toBe(400);
    }
    expect(stored).toHaveLength(0);
  });

  it('answers unavailable when the store fails, and stores the retry', async () => {
    let fail = true;
    const stored: Entry[] = [];
    const { handler } = setup({
      store: async (entries) => {
        if (fail) throw new Error('db down');
        stored.push(...entries);
      },
    });
    const token = signTenantToken('shop', SECRET);
    const body = wire([entry('e1')]);
    expect((await handler({ token, body })).status).toBe('unavailable');
    fail = false;
    expect(await handler({ token, body })).toMatchObject({ status: 'stored', stored: 1 });
    expect(stored).toHaveLength(1);
  });

  it('keeps the dedupe bounded', async () => {
    const store = vi.fn(async () => undefined);
    const { handler } = setup({ store, existing: async () => new Set(), dedupeSize: 2 });
    const token = signTenantToken('shop', SECRET);
    for (const id of ['a', 'b', 'c']) await handler({ token, body: wire([entry(id)]) });
    // `a` was forgotten (oldest first): stored again.
    await handler({ token, body: wire([entry('a')]) });
    expect(store).toHaveBeenCalledTimes(4);
  });
});

describe('wire', () => {
  it('keeps a sender time unless it is invalid or too far ahead', () => {
    expect(resolveCreatedAt('2026-11-16T11:00:00.000Z', NOW)).toEqual(
      new Date('2026-11-16T11:00:00.000Z'),
    );
    expect(resolveCreatedAt(new Date(NOW + MAX_FUTURE_SKEW_MS), NOW).getTime()).toBe(
      NOW + MAX_FUTURE_SKEW_MS,
    );
    expect(resolveCreatedAt(new Date(NOW + MAX_FUTURE_SKEW_MS + 1), NOW).getTime()).toBe(NOW);
    expect(resolveCreatedAt('nope', NOW).getTime()).toBe(NOW);
    expect(resolveCreatedAt('1969-01-01T00:00:00.000Z', NOW).getTime()).toBe(NOW);
  });

  it('parses a batch it built', () => {
    const parsed = parseIngestBatch(wire([entry('e1')]));
    expect(parsed.ok).toBe(true);
  });
});

describe('relaying entries for other apps', () => {
  const token = (tenant: string) => signTenantToken(tenant, SECRET);
  /** A verifier granting per-app capabilities (absent: no capabilities listed). */
  function relaySetup(grants: Record<string, string[] | undefined>) {
    return setup({
      verifyTenant: async ({ token: presented }) => {
        const verified = await hmacTenantVerifier(SECRET)({ token: presented });
        if (verified === null) return null;
        const capabilities = grants[verified.tenant];
        return capabilities === undefined ? verified : { ...verified, capabilities };
      },
    });
  }

  it('stores an entry tagged app:<name> as that app, with via:<relayer>', async () => {
    const { stored, handler } = relaySetup({ durable: [TELESCOPE_RELAY_CAPABILITY] });
    const outcome = await handler({
      token: token('durable'),
      body: wire([entry('r1', ['workflow:charge', 'app:shop']), entry('r2', ['workflow:own'])]),
    });
    expect(outcome).toMatchObject({ status: 'stored', app: 'durable', stored: 2, relayed: 1 });
    expect(outcome.status === 'stored' && [...outcome.apps].sort()).toEqual(['durable', 'shop']);
    expect(stored.find((e) => e.id === 'r1')?.tags).toEqual([
      'workflow:charge',
      'app:shop',
      'via:durable',
    ]);
    expect(stored.find((e) => e.id === 'r2')?.tags).toEqual(['workflow:own', 'app:durable']);
  });

  it('never relays without the capability: a token without capabilities, or with ingest only', async () => {
    const { stored, handler } = relaySetup({
      plain: undefined,
      scoped: [TELESCOPE_INGEST_CAPABILITY],
    });
    for (const tenant of ['plain', 'scoped']) {
      await handler({
        token: token(tenant),
        body: wire([entry(`${tenant}-1`, ['app:shop', 'via:x'])]),
      });
    }
    expect(stored.map((e) => e.tags)).toEqual([['app:plain'], ['app:scoped']]);
  });

  it('honours a relay scoped to some apps, rejecting the others one by one', async () => {
    const { stored, handler } = relaySetup({ durable: [`${TELESCOPE_RELAY_CAPABILITY}:shop`] });
    const outcome = await handler({
      token: token('durable'),
      body: wire([
        entry('ok', ['app:shop']),
        entry('no', ['app:billing']),
        entry('two', ['app:shop', 'app:billing']),
        entry('bad', ['app:not valid']),
        entry('own', ['app:durable']),
      ]),
    });
    expect(outcome).toMatchObject({
      status: 'stored',
      stored: 2,
      relayed: 1,
      rejected: 3,
      duplicate: 0,
    });
    expect(stored.map((e) => e.id).sort()).toEqual(['ok', 'own']);
    expect(stored.find((e) => e.id === 'own')?.tags).toEqual(['app:durable']);
  });

  it('dedupes a relay retry, and never lets a relay overwrite the app or another relay', async () => {
    const { stored, handler } = relaySetup({
      durable: [TELESCOPE_RELAY_CAPABILITY],
      other: ['telescope:*'],
    });
    const body = wire([entry('same', ['app:shop'])]);
    await handler({ token: token('durable'), body });
    expect(await handler({ token: token('durable'), body })).toMatchObject({ stored: 0 });
    // The app itself and another relayer sending the same id: the stored entry is kept as is.
    await handler({ token: token('shop'), body: wire([entry('same', ['mine'])]) });
    await handler({ token: token('other'), body: wire([entry('same', ['app:shop', 'theirs'])]) });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tags).toEqual(['app:shop', 'via:durable']);
  });

  it('reads relay scopes', () => {
    expect(relayScope(undefined)).toBeNull();
    expect(relayScope(['telescope:ingest'])).toBeNull();
    expect(relayScope(['telescope:*'])).toBe('*');
    expect(relayScope([TELESCOPE_RELAY_CAPABILITY])).toBe('*');
    expect(
      relayScope([`${TELESCOPE_RELAY_CAPABILITY}:a`, `${TELESCOPE_RELAY_CAPABILITY}:a`]),
    ).toEqual(['a']);
    expect(canRelayFor(['a'], 'a')).toBe(true);
    expect(canRelayFor(['a'], 'b')).toBe(false);
    expect(canRelayFor(null, 'a')).toBe(false);
  });

  it('lets a relay-only token send its own entries', async () => {
    const { stored, handler } = relaySetup({ durable: [`${TELESCOPE_RELAY_CAPABILITY}:shop`] });
    const outcome = await handler({ token: token('durable'), body: wire([entry('mine')]) });
    expect(outcome.status).toBe('stored');
    expect(stored[0]?.tags).toEqual(['app:durable']);
  });
});
