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
const { telescopeMikroOrmLogger } = await import('./telescope-mikro-orm.logger.js');

describe('telescopeMikroOrmLogger family hash', () => {
  it('is computed only when the recorder reads it, and only once', () => {
    const records: RecordInput[] = [];
    const logger = telescopeMikroOrmLogger((input) => records.push(input))({
      writer: () => undefined,
    });
    familyHashCalls.count = 0;

    logger.logQuery({
      query: 'select * from author where id = 42',
      params: [42],
      took: 1,
    } as never);
    expect(familyHashCalls.count).toBe(0);

    const expected = queryFamilyHash('select * from author where id = 42');
    familyHashCalls.count = 0;
    expect(records[0]?.familyHash).toBe(expected);
    expect(records[0]?.familyHash).toBe(expected);
    expect(familyHashCalls.count).toBe(1);
  });
});
