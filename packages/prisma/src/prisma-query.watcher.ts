// packages/prisma/src/prisma-query.watcher.ts
import {
  EntryType,
  type RecordInput,
  type Watcher,
  type WatcherContext,
  queryFamilyHash,
} from '@dudousxd/nestjs-telescope';

/** The structural shape of a Prisma `query` event. Mirrors `Prisma.QueryEvent`
 *  without coupling to the generated `@prisma/client` types. */
export interface PrismaQueryEvent {
  query: string;
  params: string;
  duration: number;
  timestamp?: Date;
  target?: string;
}

/** The structural slice of `PrismaClient` we depend on: an event emitter for
 *  `query` events. The host must construct the client with
 *  `log: [{ emit: 'event', level: 'query' }]` so `$on('query')` fires. */
export interface PrismaQueryEmitter {
  $on(event: 'query', callback: (event: PrismaQueryEvent) => void): void;
}

export interface PrismaQueryWatcherOptions {
  /** Queries whose duration is >= this (ms) get a 'slow' tag. Default 1000. */
  slowMs?: number;
}

/**
 * Captures every SQL statement Prisma executes via `$on('query')`.
 *
 * ## ⚠️ No request/job correlation (Prisma engine limitation)
 *
 * Unlike the MikroORM and TypeORM adapters — whose loggers run *inside* the
 * query's async context, so each query correlates to its request/job batch via
 * AsyncLocalStorage — Prisma's `prisma.$on('query', cb)` fires the event
 * **detached** from the caller's async context. The Prisma query engine emits
 * query events on its own channel, after the fact, so when this watcher records
 * them there is no active batch to attach to.
 *
 * Consequences:
 * - Captured query entries are **orphaned**: they do NOT correlate to the
 *   request or job that issued them.
 * - **N+1 detection won't apply** to Prisma queries — it's a per-batch heuristic
 *   and these queries have no batch.
 *
 * They're still captured anyway because they remain valuable on their own: a
 * full query log plus slow-query visibility (the `slow` tag). If you need
 * per-request query correlation, the MikroORM/TypeORM adapters provide it.
 *
 * ## Usage
 *
 * The host must construct `PrismaClient` with query event logging enabled, then
 * pass the client to the watcher:
 * ```ts
 * const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
 * TelescopeModule.forRoot({ watchers: [new PrismaQueryWatcher(prisma)] });
 * ```
 */
export class PrismaQueryWatcher implements Watcher {
  readonly type = EntryType.Query;
  private readonly slowMs: number;

  constructor(
    private readonly client: PrismaQueryEmitter,
    options: PrismaQueryWatcherOptions = {},
  ) {
    this.slowMs = options.slowMs ?? 1000;
  }

  register(ctx: WatcherContext): void {
    this.client.$on('query', (event) => this.safeRecord(ctx, event));
  }

  /** Build + hand a query entry to the Recorder, swallowing any failure. Core's
   *  record() is already non-throwing; this double-guard keeps the watcher safe
   *  even against a custom or regressed WatcherContext, so recording can never
   *  surface as an error on Prisma's event channel. */
  private safeRecord(ctx: WatcherContext, event: PrismaQueryEvent): void {
    try {
      const bindings = parseParams(event.params);
      const input: RecordInput = {
        type: EntryType.Query,
        content: {
          sql: event.query,
          bindings,
          took: event.duration,
        },
        familyHash: queryFamilyHash(event.query),
        durationMs: event.duration,
        ...(event.duration >= this.slowMs ? { tags: ['slow'] } : {}),
      };
      ctx.record(input);
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      console.error(`PrismaQueryWatcher: failed to record query entry: ${message}`);
    }
  }
}

/** Prisma serializes `params` as a JSON string (e.g. `'[42]'`). Parse it into
 *  an array; any malformed/non-array value degrades to `[]`. */
function parseParams(params: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(params);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
