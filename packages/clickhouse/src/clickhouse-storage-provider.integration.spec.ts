import { createClient } from '@clickhouse/client';
import { makeEntry } from '@dudousxd/nestjs-telescope-testing/conformance';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CLICKHOUSE_PASSWORD,
  CLICKHOUSE_USER,
  startClickHouse,
} from '../test/clickhouse-container.js';
import { ClickHouseStorageProvider } from './clickhouse-storage-provider.js';
import type { ClickHouseRetention } from './schema.js';

const server = await startClickHouse();
const credentials = process.env.CLICKHOUSE_URL
  ? {}
  : { username: CLICKHOUSE_USER, password: CLICKHOUSE_PASSWORD };
const admin = server
  ? createClient({ url: server.baseUrl, database: 'telescope', ...credentials })
  : null;

afterAll(async () => {
  await admin?.close();
  await server?.stop();
});

let tableCounter = 0;
const uniqueTable = (kind: string): string => {
  tableCounter += 1;
  return `it_${kind}_${Date.now()}_${tableCounter}`;
};

function provider(
  retention: ClickHouseRetention,
  table = uniqueTable('entries'),
): ClickHouseStorageProvider {
  return new ClickHouseStorageProvider({
    client: admin!,
    table,
    rollupTable: uniqueTable('rollups'),
    retention,
  });
}

async function engineFull(table: string): Promise<string> {
  const result = await admin!.query({
    query:
      'SELECT engine_full FROM system.tables WHERE database = currentDatabase() AND name = {name:String}',
    query_params: { name: table },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ engine_full: string }>();
  return rows[0]?.engine_full ?? '';
}

describe.skipIf(server === null)('ClickHouseStorageProvider against a real server', () => {
  it('expires each type at its own retention when parts merge', async () => {
    const table = uniqueTable('entries');
    const store = provider({ default: '1h', perType: { exception: '90d' } }, table);
    await store.init();
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await store.store([
      makeEntry({ id: 'old-request', type: 'request', createdAt: old }),
      makeEntry({ id: 'old-exception', type: 'exception', createdAt: old }),
      makeEntry({ id: 'new-request', type: 'request', createdAt: new Date() }),
    ]);
    // TTL is applied by merges; a forced final merge applies it now.
    await admin!.command({ query: `OPTIMIZE TABLE ${table} FINAL` });
    const page = await store.get({});
    expect(page.data.map((entry) => entry.id).sort()).toEqual(['new-request', 'old-exception']);
  });

  it('re-applies a changed retention at boot, and leaves an unchanged one alone', async () => {
    const table = uniqueTable('ttl');
    await provider({ default: '1h' }, table).init();
    expect(await engineFull(table)).toContain('toIntervalSecond(3600)');

    await provider({ default: '2h', perType: { exception: '1d' } }, table).init();
    const changed = await engineFull(table);
    expect(changed).toContain('toIntervalSecond(7200)');
    expect(changed).toContain('toIntervalSecond(86400)');

    const mutationsBefore = await admin!.query({
      query: 'SELECT count() AS n FROM system.mutations WHERE table = {table:String}',
      query_params: { table },
      format: 'JSONEachRow',
    });
    const before = Number((await mutationsBefore.json<{ n: string }>())[0]?.n);
    await provider({ default: '2h', perType: { exception: '1d' } }, table).init();
    const mutationsAfter = await admin!.query({
      query: 'SELECT count() AS n FROM system.mutations WHERE table = {table:String}',
      query_params: { table },
      format: 'JSONEachRow',
    });
    expect(Number((await mutationsAfter.json<{ n: string }>())[0]?.n)).toBe(before);
  });

  it('keeps one copy when an update moves the entry to another type', async () => {
    const store = provider({ default: '1d' });
    await store.init();
    const createdAt = new Date(Date.now() - 1000);
    await store.store([makeEntry({ id: 'moving', type: 'request', createdAt })]);
    await store.update('moving', { type: 'job' });
    const page = await store.get({});
    expect(page.data.map((entry) => [entry.id, entry.type])).toEqual([['moving', 'job']]);
    expect((await store.get({ type: 'request' })).data).toEqual([]);
  });

  it('serves the newest version of an updated entry after a merge', async () => {
    const table = uniqueTable('entries');
    const store = provider({ default: '1d' }, table);
    await store.init();
    await store.store([makeEntry({ id: 'e', createdAt: new Date(Date.now() - 1000) })]);
    await store.update('e', { durationMs: 1 });
    await store.update('e', { durationMs: 2 });
    await admin!.command({ query: `OPTIMIZE TABLE ${table} FINAL` });
    const found = await store.find('e');
    expect(found?.durationMs).toBe(2);
    expect((await store.get({})).data).toHaveLength(1);
  });

  it('leaves a host-owned client open on close()', async () => {
    const store = provider({ default: '1d' });
    await store.init();
    await store.close();
    expect((await admin!.ping()).success).toBe(true);
  });
});
