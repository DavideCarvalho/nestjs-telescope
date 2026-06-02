// packages/typeorm/src/telescope-typeorm.logger.spec.ts
import type { RecordInput } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { telescopeTypeOrmLogger } from './telescope-typeorm.logger.js';

describe('telescopeTypeOrmLogger', () => {
  it('records a query entry with sql, bindings, and familyHash from logQuery', () => {
    const records: RecordInput[] = [];
    const logger = telescopeTypeOrmLogger((input) => records.push(input));

    logger.logQuery('select * from t where id = ?', [42]);

    expect(records).toHaveLength(1);
    const entry = records[0]!;
    expect(entry.type).toBe('query');
    expect((entry.content as { sql: string }).sql).toContain('t');
    expect((entry.content as { bindings: unknown[] }).bindings).toEqual([42]);
    // TypeORM's logQuery gives no duration -> took is null.
    expect((entry.content as { took: number | null }).took).toBeNull();
    expect(entry.familyHash).toBeTruthy();
  });

  it('coerces missing parameters to an empty bindings array', () => {
    const records: RecordInput[] = [];
    const logger = telescopeTypeOrmLogger((input) => records.push(input));

    logger.logQuery('select 1');

    expect((records[0]!.content as { bindings: unknown[] }).bindings).toEqual([]);
  });

  it('records slow queries with a duration and a slow tag via logQuerySlow', () => {
    const records: RecordInput[] = [];
    const logger = telescopeTypeOrmLogger((input) => records.push(input));

    logger.logQuerySlow(1500, 'select * from t where id = ?', [7]);

    expect(records).toHaveLength(1);
    const entry = records[0]!;
    expect(entry.type).toBe('query');
    expect((entry.content as { bindings: unknown[] }).bindings).toEqual([7]);
    expect(entry.durationMs).toBe(1500);
    expect(entry.tags).toContain('slow');
    expect(entry.familyHash).toBeTruthy();
  });

  it('does not double-record: logQuery and other Logger methods are independent', () => {
    const records: RecordInput[] = [];
    const logger = telescopeTypeOrmLogger((input) => records.push(input));

    logger.logQueryError('boom', 'select 1', []);
    logger.logSchemaBuild('create table');
    logger.logMigration('migrating');
    logger.log('info', 'hello');

    expect(records).toHaveLength(0);
  });
});
