// packages/drizzle/src/telescope-drizzle.logger.ts
//
// Query capture for Drizzle: a Drizzle `Logger` that records every statement as a Telescope
// `query` entry. Drizzle calls `logQuery` synchronously, inside the caller's async context, just
// before it sends the statement, so each entry joins the request or job batch that ran it and the
// N+1 detector sees it.
//
// Drizzle's logger hook has no "after" call, so the entry carries no duration: `took` and
// `durationMs` are null and nothing is tagged `slow`. Durations of database calls come from the
// OpenTelemetry `pg` instrumentation when a host runs it, which this logger then defers to (see
// `markCoveredByTelescope` below).
import {
  EntryType,
  type RecordInput,
  queryFamilyHash,
  telescopeRecord,
} from '@dudousxd/nestjs-telescope';
// Namespace import: `markCoveredByTelescope` is optional on older cores.
import * as telescope from '@dudousxd/nestjs-telescope';
import { DefaultLogger, type Logger } from 'drizzle-orm';

export interface TelescopeDrizzleLoggerOptions {
  /**
   * Also log each query the way Drizzle's own `logger: true` does (`true`), or through another
   * Drizzle logger. Default `false`: recorded into Telescope only.
   */
  echo?: boolean | Logger;
  /**
   * Leave query capture to OpenTelemetry instead: when `false`, the logger does not mark `query`
   * as covered, so the span processor keeps the `pg` driver spans (which carry durations) and this
   * logger's entries come in next to them. Default `true`.
   */
  coverQueries?: boolean;
}

/**
 * A Drizzle `Logger` that tees every query into `record`. When `record` is omitted it resolves the
 * boot-time `telescopeRecord` sink on each call, so it works even when Drizzle is created before
 * `TelescopeModule` is wired (queries before that are dropped).
 */
export class TelescopeDrizzleLogger implements Logger {
  private readonly echo: Logger | null;

  constructor(
    private readonly _record?: (input: RecordInput) => void,
    options: TelescopeDrizzleLoggerOptions = {},
  ) {
    this.echo =
      options.echo === true
        ? new DefaultLogger()
        : options.echo === false || options.echo === undefined
          ? null
          : options.echo;
    // SQL is recorded here, so the OpenTelemetry span processor skips the DB driver spans.
    if (options.coverQueries !== false) telescope.markCoveredByTelescope?.('query');
  }

  logQuery(query: string, params: unknown[]): void {
    if (query) {
      const record = this._record ?? telescopeRecord;
      let familyHash: string | undefined;
      try {
        record({
          type: EntryType.Query,
          content: { sql: query, bindings: Array.isArray(params) ? [...params] : [], took: null },
          // Read by the recorder only once it keeps the entry, so a sampled-out or paused query
          // never pays for normalizing its SQL.
          get familyHash() {
            familyHash ??= queryFamilyHash(query);
            return familyHash;
          },
          durationMs: null,
        });
      } catch {
        // Recording never fails the query it observes.
      }
    }
    this.echo?.logQuery(query, params);
  }
}

/**
 * Builds the `logger` for `drizzle(...)`:
 *
 * ```ts
 * const db = drizzle({ client: pool, logger: telescopeDrizzleLogger() });
 * // or, with an explicit sink and Drizzle's own console logging kept:
 * const db = drizzle({ client: pool, logger: telescopeDrizzleLogger((input) => telescope.record(input), { echo: true }) });
 * ```
 */
export function telescopeDrizzleLogger(
  options?: TelescopeDrizzleLoggerOptions,
): TelescopeDrizzleLogger;
export function telescopeDrizzleLogger(
  record: ((input: RecordInput) => void) | undefined,
  options?: TelescopeDrizzleLoggerOptions,
): TelescopeDrizzleLogger;
export function telescopeDrizzleLogger(
  recordOrOptions?: ((input: RecordInput) => void) | TelescopeDrizzleLoggerOptions,
  maybeOptions: TelescopeDrizzleLoggerOptions = {},
): TelescopeDrizzleLogger {
  const record = typeof recordOrOptions === 'function' ? recordOrOptions : undefined;
  const options =
    typeof recordOrOptions === 'function' || recordOrOptions === undefined
      ? maybeOptions
      : recordOrOptions;
  return new TelescopeDrizzleLogger(record, options);
}
