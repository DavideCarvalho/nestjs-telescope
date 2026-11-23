// packages/drizzle/src/telescope-drizzle.logger.spec.ts
import type { RecordInput } from '@dudousxd/nestjs-telescope';
import { setTelescopeRecordSink } from '@dudousxd/nestjs-telescope';
import * as telescope from '@dudousxd/nestjs-telescope';
import type { Logger } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelescopeDrizzleLogger, telescopeDrizzleLogger } from './telescope-drizzle.logger.js';

describe('telescopeDrizzleLogger', () => {
  afterEach(() => {
    setTelescopeRecordSink(null);
    vi.restoreAllMocks();
  });

  it('records a query entry with the sql, its bindings and a family hash, and no duration', () => {
    const records: RecordInput[] = [];
    const logger = telescopeDrizzleLogger((input) => records.push(input));
    logger.logQuery('select "id" from "author" where "id" = $1', [42]);

    expect(records).toHaveLength(1);
    const entry = records[0];
    expect(entry?.type).toBe('query');
    expect(entry?.content).toEqual({
      sql: 'select "id" from "author" where "id" = $1',
      bindings: [42],
      took: null,
    });
    expect(entry?.durationMs).toBeNull();
    expect(entry?.familyHash).toBe(
      telescope.queryFamilyHash('select "id" from "author" where "id" = $1'),
    );
    expect(entry?.tags).toBeUndefined();
  });

  it('gives queries that differ only in literals the same family', () => {
    const records: RecordInput[] = [];
    const logger = telescopeDrizzleLogger((input) => records.push(input));
    logger.logQuery('select * from author where id = 1', []);
    logger.logQuery('select * from author where id = 2', []);
    expect(records[0]?.familyHash).toBe(records[1]?.familyHash);
  });

  it('copies the bindings, so a later change to the array is not recorded', () => {
    const records: RecordInput[] = [];
    const params: unknown[] = [1];
    telescopeDrizzleLogger((input) => records.push(input)).logQuery('select $1', params);
    params.push(2);
    expect((records[0]?.content as { bindings: unknown[] }).bindings).toEqual([1]);
  });

  it('never throws into the query when recording fails', () => {
    const logger = telescopeDrizzleLogger(() => {
      throw new Error('sink down');
    });
    expect(() => logger.logQuery('select 1', [])).not.toThrow();
  });

  it('is silent by default, and echoes through Drizzle’s own logger with echo: true', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    telescopeDrizzleLogger(() => undefined).logQuery('select 1', []);
    expect(log).not.toHaveBeenCalled();
    telescopeDrizzleLogger(() => undefined, { echo: true }).logQuery('select 1', []);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('echoes through a given Drizzle logger', () => {
    const inner: Logger = { logQuery: vi.fn() };
    telescopeDrizzleLogger(() => undefined, { echo: inner }).logQuery('select 1', [7]);
    expect(inner.logQuery).toHaveBeenCalledWith('select 1', [7]);
  });

  it('with no record fn, records through the global sink once it is bound', () => {
    const logger = telescopeDrizzleLogger();
    expect(() => logger.logQuery('select 1', [])).not.toThrow();
    const records: RecordInput[] = [];
    setTelescopeRecordSink((input) => records.push(input));
    logger.logQuery('select 1', []);
    expect(records).toHaveLength(1);
  });

  it('an explicit record fn wins over a bound global sink', () => {
    const explicit: RecordInput[] = [];
    const global: RecordInput[] = [];
    setTelescopeRecordSink((input) => global.push(input));
    telescopeDrizzleLogger((input) => explicit.push(input)).logQuery('select 1', []);
    expect(explicit).toHaveLength(1);
    expect(global).toHaveLength(0);
  });

  it('treats a non-function first argument as the options', () => {
    const inner: Logger = { logQuery: vi.fn() };
    const logger = telescopeDrizzleLogger({ echo: inner });
    expect(logger).toBeInstanceOf(TelescopeDrizzleLogger);
    logger.logQuery('select 1', []);
    expect(inner.logQuery).toHaveBeenCalledTimes(1);
  });

  it('marks queries covered for the OpenTelemetry bridge, unless coverQueries is false', () => {
    const before = telescope.telescopeRuntime().covered.get('query') ?? 0;
    telescopeDrizzleLogger(() => undefined);
    expect(telescope.telescopeRuntime().covered.get('query')).toBe(before + 1);
    telescopeDrizzleLogger(() => undefined, { coverQueries: false });
    expect(telescope.telescopeRuntime().covered.get('query')).toBe(before + 1);
  });
});
