// packages/mikro-orm/src/mikro-orm-storage.provider.fingerprint.spec.ts
//
// Integration: the schema fingerprint gate that wraps `ensureDatabase` +
// `schema.update` inside `init()`. Uses a real MikroORM SqliteDriver on a temp
// FILE db so a second connection (and a second provider) can observe the marker
// table the gate maintains across boots.
//
// `schema.update` / `ensureDatabase` live on the SHARED `SqlSchemaGenerator`
// prototype, so spying the prototype catches the provider's owned-ORM calls even
// though the instance is created inside init(). Likewise the marker CREATE is a
// raw `connection.execute`, observable on the shared connection prototype.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entry } from '@dudousxd/nestjs-telescope';
import { MikroORM } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MikroOrmStorageProvider } from './mikro-orm-storage.provider.js';

let idCounter = 0;
function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: overrides.id ?? `fp-${idCounter++}`,
    batchId: 'b1',
    type: 'request',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i1',
    traceId: null,
    spanId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** A bare connection (no telescope metadata) to observe/mutate the marker row. */
async function bareOrm(dbFile: string): Promise<MikroORM> {
  return MikroORM.init({
    driver: SqliteDriver,
    dbName: dbFile,
    entities: [],
    allowGlobalContext: true,
    discovery: { warnWhenNoEntities: false },
  });
}

async function readMarker(dbFile: string): Promise<Array<Record<string, unknown>>> {
  const orm = await bareOrm(dbFile);
  const rows = await orm.em
    .getConnection()
    .execute('select id, fingerprint, applied_at from telescope_schema_meta');
  await orm.close(true);
  return rows;
}

/** Walks an object's prototype chain to the level that OWNS `method`. */
function protoOwning(instance: object, method: string): Record<string, unknown> {
  let proto = Object.getPrototypeOf(instance);
  while (proto && !Object.getOwnPropertyNames(proto).includes(method)) {
    proto = Object.getPrototypeOf(proto);
  }
  return proto;
}

describe('MikroOrmStorageProvider schema fingerprint gate (file sqlite)', () => {
  let schemaProto: Record<string, unknown>;
  let connProto: Record<string, unknown>;

  beforeAll(async () => {
    const probe = await bareOrm(':memory:');
    schemaProto = protoOwning(probe.schema, 'update');
    connProto = protoOwning(probe.em.getConnection(), 'execute');
    await probe.close(true);
  });

  function tempDbFile(): string {
    return join(tmpdir(), `telescope-fp-${process.pid}-${idCounter++}.sqlite`);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips schema.update on a second init when the stored fingerprint matches', async () => {
    const dbFile = tempDbFile();
    rmSync(dbFile, { force: true });
    try {
      // init #1 heals + writes the marker.
      const first = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: dbFile });
      await first.init();
      await first.close();

      // Sentinel applied_at: only the heal branch rewrites the marker, so if it
      // stays 1 across init #2 the gate must have skipped the heal.
      const seed = await bareOrm(dbFile);
      await seed.em.getConnection().execute('update telescope_schema_meta set applied_at = 1');
      await seed.close(true);

      const updateSpy = vi.spyOn(schemaProto, 'update');
      const second = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: dbFile });
      await second.init();
      await second.close();

      expect(updateSpy).not.toHaveBeenCalled();
      const rows = await readMarker(dbFile);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.applied_at)).toBe(1);
    } finally {
      rmSync(dbFile, { force: true });
    }
  });

  it('on a fresh database runs ensureDatabase + schema.update, then writes the marker', async () => {
    const dbFile = tempDbFile();
    rmSync(dbFile, { force: true });
    let provider: MikroOrmStorageProvider | null = null;
    try {
      const ensureSpy = vi.spyOn(schemaProto, 'ensureDatabase');
      const updateSpy = vi.spyOn(schemaProto, 'update');

      provider = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: dbFile });
      await provider.init();

      // The entries table was created and is usable.
      await provider.store([makeEntry({ id: 'fresh' })]);
      expect((await provider.get({})).data.map((e) => e.id)).toEqual(['fresh']);

      expect(ensureSpy).toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ safe: true }));

      // The marker persisted a real sha256 fingerprint + an epoch-ms applied_at.
      const rows = await readMarker(dbFile);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe('mikro-orm');
      expect(String(rows[0]?.fingerprint)).toMatch(/^[0-9a-f]{64}$/);
      expect(Number(rows[0]?.applied_at)).toBeGreaterThan(0);
    } finally {
      await provider?.close();
      rmSync(dbFile, { force: true });
    }
  });

  it('re-heals when the stored fingerprint no longer matches', async () => {
    const dbFile = tempDbFile();
    rmSync(dbFile, { force: true });
    try {
      const first = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: dbFile });
      await first.init();
      await first.close();

      // Corrupt the stored fingerprint (e.g. an entity change since last boot)
      // and sentinel applied_at.
      const seed = await bareOrm(dbFile);
      await seed.em
        .getConnection()
        .execute("update telescope_schema_meta set fingerprint = 'stale', applied_at = 1");
      await seed.close(true);

      const updateSpy = vi.spyOn(schemaProto, 'update');
      const second = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: dbFile });
      await second.init();
      await second.close();

      expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ safe: true }));
      const rows = await readMarker(dbFile);
      expect(String(rows[0]?.fingerprint)).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.fingerprint).not.toBe('stale');
      expect(Number(rows[0]?.applied_at)).not.toBe(1);
    } finally {
      rmSync(dbFile, { force: true });
    }
  });

  it('runs ensureDatabase before creating the marker table on a fresh database', async () => {
    const dbFile = tempDbFile();
    rmSync(dbFile, { force: true });
    let provider: MikroOrmStorageProvider | null = null;
    try {
      const order: string[] = [];
      const realEnsure = schemaProto.ensureDatabase as (...args: any[]) => Promise<unknown>;
      const realExecute = connProto.execute as (...args: any[]) => Promise<unknown>;

      vi.spyOn(schemaProto, 'ensureDatabase').mockImplementation(async function (
        this: any,
        ...args: any[]
      ) {
        order.push('ensureDatabase');
        return realEnsure.apply(this, args);
      });
      vi.spyOn(connProto, 'execute').mockImplementation(async function (this: any, ...args: any[]) {
        const sql = args[0];
        if (typeof sql === 'string' && sql.includes('telescope_schema_meta')) {
          order.push('createMarker');
        }
        return realExecute.apply(this, args);
      });

      provider = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: dbFile });
      await provider.init();

      expect(order).toContain('ensureDatabase');
      expect(order).toContain('createMarker');
      expect(order.indexOf('ensureDatabase')).toBeLessThan(order.indexOf('createMarker'));
    } finally {
      await provider?.close();
      rmSync(dbFile, { force: true });
    }
  });
});
