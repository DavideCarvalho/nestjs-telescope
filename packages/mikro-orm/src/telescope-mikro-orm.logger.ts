// packages/mikro-orm/src/telescope-mikro-orm.logger.ts
import {
  EntryType,
  type RecordInput,
  queryFamilyHash,
  telescopeRecord,
} from '@dudousxd/nestjs-telescope';
import { DefaultLogger, type LogContext, type LoggerOptions } from '@mikro-orm/core';

export interface TelescopeLoggerOptions {
  /** Queries at/above this many ms get a 'slow' tag. Default 100. */
  slowMs?: number;
  /**
   * Suppress MikroORM's own console output while still recording into Telescope.
   * Enable this when `debug` is only turned on to feed Telescope and you don't
   * want every query echoed to stdout. Default false.
   */
  silent?: boolean;
}

/** A MikroORM DefaultLogger subclass that tees every executed query into
 *  `record`, while preserving MikroORM's own logging behavior via super.
 *  When `record` is omitted, each `logQuery` lazily resolves the boot-time
 *  `telescopeRecord` global sink instead — see {@link telescopeMikroOrmLogger}. */
export class TelescopeMikroOrmLogger extends DefaultLogger {
  constructor(
    options: LoggerOptions,
    private readonly _record: ((input: RecordInput) => void) | undefined,
    private readonly slowMs: number,
  ) {
    super(options);
  }

  // Matches DefaultLogger.logQuery's concrete signature exactly.
  override logQuery(context: { query: string } & LogContext): void {
    const sql = context.query;
    if (sql) {
      const took = typeof context.took === 'number' ? context.took : null;
      const tags: string[] = took !== null && took >= this.slowMs ? ['slow'] : [];
      // Resolved AT CALL TIME (not captured at construction) so that when no
      // explicit `record` was supplied, binding order doesn't matter: MikroORM
      // can construct this logger (via `MikroORM.init()`) before Nest DI has
      // wired `TelescopeService`, and `telescopeRecord` is a no-op until then.
      const record = this._record ?? telescopeRecord;
      record({
        type: EntryType.Query,
        content: {
          sql,
          bindings: Array.isArray(context.params) ? [...context.params] : [],
          took,
        },
        familyHash: queryFamilyHash(sql),
        durationMs: took,
        ...(tags.length > 0 ? { tags } : {}),
      });
    }
    super.logQuery(context);
  }
}

/** Builds a `loggerFactory`-compatible function that records every query.
 *
 * Host-wired usage:
 * ```ts
 * MikroORM.init({
 *   debug: ['query'],
 *   // Capture queries for Telescope without spamming the console:
 *   loggerFactory: telescopeMikroOrmLogger(record, { slowMs: 100, silent: true }),
 * });
 * ```
 *
 * Zero-config usage — omit `record` entirely and the logger resolves the
 * boot-time global sink (`telescopeRecord`) at call time, so it works even
 * when `MikroORM.init()` runs before `TelescopeModule` has wired anything
 * (entries are simply dropped until it does):
 * ```ts
 * MikroORM.init({
 *   debug: ['query'],
 *   loggerFactory: telescopeMikroOrmLogger(),
 * });
 * ```
 */
export function telescopeMikroOrmLogger(
  record?: (input: RecordInput) => void,
  options: TelescopeLoggerOptions = {},
): (loggerOptions: LoggerOptions) => TelescopeMikroOrmLogger {
  const slowMs = options.slowMs ?? 100;
  const silent = options.silent ?? false;
  // When silent, swap MikroORM's writer for a no-op so `super.logQuery` records
  // into Telescope but never echoes to stdout. Queries still flow because the
  // host keeps `debug` enabled — only the console output is dropped.
  return (loggerOptions: LoggerOptions) =>
    new TelescopeMikroOrmLogger(
      silent ? { ...loggerOptions, writer: () => undefined } : loggerOptions,
      record,
      slowMs,
    );
}
