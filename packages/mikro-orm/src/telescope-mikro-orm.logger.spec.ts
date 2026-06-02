// packages/mikro-orm/src/telescope-mikro-orm.logger.spec.ts
import type { RecordInput } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { telescopeMikroOrmLogger } from './telescope-mikro-orm.logger.js';

describe('telescopeMikroOrmLogger', () => {
  it('records a query entry with sql, bindings, duration, familyHash, and slow tag', () => {
    const records: RecordInput[] = [];
    const record = (input: RecordInput) => records.push(input);
    // telescopeMikroOrmLogger returns a loggerFactory; construct one with a no-op writer.
    const logger = telescopeMikroOrmLogger(record, { slowMs: 100 })({ writer: () => undefined });

    // Drive the query-log hook with a structured context (shape per installed MikroORM v7.1.3).
    // DefaultLogger.logQuery takes { query: string } & LogContext where LogContext has
    // params?: readonly unknown[], took?: number, level?: 'info' | 'warning' | 'error'
    logger.logQuery({
      query: 'select * from author where id = ?',
      params: [42],
      took: 150,
      level: 'info',
    } as never);

    expect(records).toHaveLength(1);
    const entry = records[0]!;
    expect(entry.type).toBe('query');
    expect((entry.content as { sql: string }).sql).toContain('author');
    expect((entry.content as { bindings: unknown[] }).bindings).toEqual([42]);
    expect(entry.durationMs).toBe(150);
    expect(entry.familyHash).toBeTruthy();
    expect(entry.tags).toContain('slow'); // 150 >= 100
  });

  it('does not tag fast queries as slow', () => {
    const records: RecordInput[] = [];
    const logger = telescopeMikroOrmLogger((i) => records.push(i), { slowMs: 100 })({
      writer: () => undefined,
    });
    logger.logQuery({ query: 'select 1', params: [], took: 5, level: 'info' } as never);
    expect(records[0]?.tags ?? []).not.toContain('slow');
  });
});
