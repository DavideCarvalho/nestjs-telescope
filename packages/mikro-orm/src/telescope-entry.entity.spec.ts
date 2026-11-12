// packages/mikro-orm/src/telescope-entry.entity.spec.ts
import type { Entry } from '@dudousxd/nestjs-telescope';
import { MikroORM } from '@mikro-orm/core';
import { BaseMySqlPlatform } from '@mikro-orm/sql';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';
import { MikroOrmStorageProvider } from './mikro-orm-storage.provider.js';
import { TelescopeEntry } from './telescope-entry.entity.js';

describe('TelescopeEntry createdAt', () => {
  it('is declared with millisecond precision (datetime(3) on MySQL)', async () => {
    const orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [TelescopeEntry],
      allowGlobalContext: true,
    });
    try {
      const createdAt = orm.getMetadata().get(TelescopeEntry).properties.createdAt;
      expect(createdAt.length).toBe(3);
      const mysql = new BaseMySqlPlatform();
      expect(mysql.getDateTimeTypeDeclarationSQL({ length: createdAt.length ?? 0 })).toBe(
        'datetime(3)',
      );
    } finally {
      await orm.close(true);
    }
  });

  it('round-trips milliseconds', async () => {
    const storage = new MikroOrmStorageProvider({ driver: SqliteDriver, dbName: ':memory:' });
    await storage.init();
    try {
      const createdAt = new Date(1_700_000_000_123);
      const entry: Entry = {
        id: 'ms-1',
        batchId: 'b1',
        type: 'span',
        familyHash: null,
        content: {},
        tags: [],
        sequence: 0,
        durationMs: 5,
        origin: 'http',
        instanceId: 'i1',
        traceId: 't'.repeat(32),
        spanId: null,
        createdAt,
      };
      await storage.store([entry]);
      const page = await storage.get({ traceId: 't'.repeat(32), limit: 10 });
      expect(page.data[0]?.createdAt.getTime()).toBe(createdAt.getTime());
    } finally {
      await storage.close();
    }
  });
});
