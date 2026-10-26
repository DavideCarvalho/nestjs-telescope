import type { RecordInput } from '@dudousxd/nestjs-telescope';
import { describe, expect, it, vi } from 'vitest';

const familyHashCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@dudousxd/nestjs-telescope', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dudousxd/nestjs-telescope')>();
  return {
    ...original,
    queryFamilyHash: (sql: string) => {
      familyHashCalls.count += 1;
      return original.queryFamilyHash(sql);
    },
  };
});

const { queryFamilyHash } = await import('@dudousxd/nestjs-telescope');
const { TelescopeTypeOrmLogger } = await import('./telescope-typeorm.logger.js');

describe('TelescopeTypeOrmLogger family hash', () => {
  it('is computed only when the recorder reads it, and only once', () => {
    const records: RecordInput[] = [];
    const logger = new TelescopeTypeOrmLogger((input) => records.push(input));
    familyHashCalls.count = 0;

    logger.logQuery('select * from author where id = 1', [1]);
    logger.logQuerySlow(2_000, 'select * from book where id = 2', [2]);
    expect(familyHashCalls.count).toBe(0);

    const expected = [
      queryFamilyHash('select * from author where id = 1'),
      queryFamilyHash('select * from book where id = 2'),
    ];
    familyHashCalls.count = 0;
    expect(records.map((record) => record.familyHash)).toEqual(expected);
    expect(records.map((record) => record.familyHash)).toEqual(expected);
    expect(familyHashCalls.count).toBe(2);
  });
});
