// packages/mikro-orm-watcher/src/mikro-orm-model.watcher.ts
import {
  EntryType,
  type RecordInput,
  type Watcher,
  type WatcherContext,
} from '@dudousxd/nestjs-telescope';
import { MikroORM, wrap } from '@mikro-orm/core';
import { Logger } from '@nestjs/common';

/** A MikroORM lifecycle event payload (structural — the subset we read from
 *  `EventArgs`). `entity` is the affected entity instance, `meta` carries the
 *  entity metadata, `changeSet` the diff (absent on deletes). */
export interface MikroOrmEventArgs {
  entity: object;
  meta?: { className?: string; name?: string };
  changeSet?: { payload?: Record<string, unknown> };
}

/** Flush / transaction event args (MikroORM's `FlushEventArgs` /
 *  `TransactionEventArgs`). Both carry the `em` driving the operation, used to
 *  key per-operation timing so concurrent forks never share a start slot. */
export interface MikroOrmTimedEventArgs {
  em: object;
}

/** The structural surface we need from a resolved `MikroORM` instance: an
 *  `EntityManager` whose event manager accepts a subscriber registration. */
export interface MikroOrmLike {
  em: {
    getEventManager(): {
      registerSubscriber(subscriber: unknown): void;
    };
  };
}

/** Content shape for model-entity lifecycle entries (create/update/delete). */
export interface ModelEntryContent {
  kind: 'entity';
  action: 'create' | 'update' | 'delete';
  entity: string;
  id: string | null;
  changes: Record<string, unknown> | null;
}

/** Content shape for flush lifecycle entries. */
export interface FlushEntryContent {
  kind: 'flush';
}

/** Content shape for transaction lifecycle entries. */
export interface TransactionEntryContent {
  kind: 'transaction';
  outcome: 'committed' | 'rolled-back';
}

/** Union of all content shapes this watcher emits. */
export type MikroOrmEntryContent = ModelEntryContent | FlushEntryContent | TransactionEntryContent;

/** Telescope's own storage entities — never recorded, to avoid a feedback loop
 *  where persisting an entry triggers another model entry. */
const TELESCOPE_ENTITY_NAMES = new Set(['TelescopeEntry', 'TelescopeRollup']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Narrows a resolved provider to a usable `MikroORM`-like instance. */
function hasEventManager(value: unknown): value is MikroOrmLike {
  if (!isRecord(value)) return false;
  const em = value.em;
  return isRecord(em) && typeof em.getEventManager === 'function';
}

/** Resolve the className for an event, preferring `meta.className`. */
function resolveEntityName(args: MikroOrmEventArgs): string {
  return args.meta?.className ?? args.meta?.name ?? args.entity.constructor.name;
}

/** Resolve the entity's primary key as a string, or null when unassigned.
 *  `wrap(entity, true)` returns the internal wrapper, which exposes
 *  `getPrimaryKey()`. */
function resolvePrimaryKey(entity: object): string | null {
  try {
    const primaryKey = wrap(entity, true).getPrimaryKey();
    return primaryKey === null || primaryKey === undefined ? null : String(primaryKey);
  } catch {
    return null;
  }
}

/**
 * Captures MikroORM entity lifecycle changes (create / update / delete) as well
 * as flush and transaction lifecycle events with durations, recording telescope
 * entries correlated to the active request/job batch.
 *
 * ## Entity changes
 * On each `afterCreate` / `afterUpdate` / `afterDelete` hook it records
 * `{ kind: 'entity', action, entity, id, changes }`. The subscriber runs in the
 * flushing async context, so each entry lands in the request/job batch that
 * triggered the flush — no batch is opened here.
 *
 * ## Flush lifecycle
 * On `onFlush` the start time is captured. On `afterFlush` the elapsed
 * `durationMs` is set and a `{ kind: 'flush' }` entry is recorded.
 *
 * ## Transaction lifecycle
 * On `beforeTransactionStart` the start time is captured. On
 * `afterTransactionCommit` / `afterTransactionRollback` the elapsed `durationMs`
 * is set and a `{ kind: 'transaction', outcome }` entry is recorded.
 *
 * ## Feedback-loop guard
 * Telescope's own storage entities (`TelescopeEntry` / `TelescopeRollup`) are
 * skipped by class name, so persisting an entry never records another entry.
 *
 * ## Resilience
 * If `@mikro-orm/core` / `MikroORM` isn't available, or the resolved provider
 * has no usable event manager, the watcher logs a warning and no-ops — it never
 * throws. Registration is idempotent (a guard flag).
 */
export class MikroOrmModelWatcher implements Watcher {
  readonly type = EntryType.Model;
  private readonly logger = new Logger(MikroOrmModelWatcher.name);
  private registered = false;

  register(ctx: WatcherContext): void {
    if (this.registered) return;
    this.registered = true;

    const orm = this.resolveOrm(ctx);
    if (!orm) {
      this.logger.warn(
        'MikroOrmModelWatcher: MikroORM (@mikro-orm/core) not found or has no event manager. ' +
          'Model changes will not be captured.',
      );
      return;
    }

    const watcher = this;

    // Timing is keyed by the EntityManager from the event args, NOT a single
    // shared slot: the subscriber is registered on the shared EventManager, so
    // concurrent flushes/transactions from different forked EMs interleave their
    // begin/end hooks. A WeakMap keyed by the per-operation `em` correlates each
    // end with its own start, races nothing, and never leaks (the EM is GC'd).
    const flushStartByEm = new WeakMap<object, number>();
    const txStartByEm = new WeakMap<object, number>();

    const subscriber = {
      afterCreate(args: MikroOrmEventArgs): void {
        watcher.safeRecord(ctx, 'create', args);
      },
      afterUpdate(args: MikroOrmEventArgs): void {
        watcher.safeRecord(ctx, 'update', args);
      },
      afterDelete(args: MikroOrmEventArgs): void {
        watcher.safeRecord(ctx, 'delete', args);
      },

      onFlush(args: MikroOrmTimedEventArgs): void {
        flushStartByEm.set(args.em, Date.now());
      },

      afterFlush(args: MikroOrmTimedEventArgs): void {
        const start = flushStartByEm.get(args.em);
        flushStartByEm.delete(args.em);
        const durationMs = start !== undefined ? Date.now() - start : null;
        watcher.safeRecordFlush(ctx, durationMs);
      },

      beforeTransactionStart(args: MikroOrmTimedEventArgs): void {
        txStartByEm.set(args.em, Date.now());
      },

      afterTransactionCommit(args: MikroOrmTimedEventArgs): void {
        const start = txStartByEm.get(args.em);
        txStartByEm.delete(args.em);
        const durationMs = start !== undefined ? Date.now() - start : null;
        watcher.safeRecordTransaction(ctx, 'committed', durationMs);
      },

      afterTransactionRollback(args: MikroOrmTimedEventArgs): void {
        const start = txStartByEm.get(args.em);
        txStartByEm.delete(args.em);
        const durationMs = start !== undefined ? Date.now() - start : null;
        watcher.safeRecordTransaction(ctx, 'rolled-back', durationMs);
      },
    };

    try {
      orm.em.getEventManager().registerSubscriber(subscriber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`MikroOrmModelWatcher: failed to register subscriber: ${message}`);
    }
  }

  /** Resolve the singleton `MikroORM` from the Nest container; null when the
   *  optional peer isn't wired or the provider has no event manager. */
  private resolveOrm(ctx: WatcherContext): MikroOrmLike | null {
    try {
      const found = ctx.moduleRef.get(MikroORM, { strict: false });
      return hasEventManager(found) ? found : null;
    } catch {
      return null;
    }
  }

  /** Build + record a model entity-change entry, skipping Telescope's own
   *  entities and swallowing any failure so a telescope error can never break
   *  a flush. */
  private safeRecord(
    ctx: WatcherContext,
    action: 'create' | 'update' | 'delete',
    args: MikroOrmEventArgs,
  ): void {
    try {
      const entity = resolveEntityName(args);
      if (TELESCOPE_ENTITY_NAMES.has(entity)) return;

      const content: ModelEntryContent = {
        kind: 'entity',
        action,
        entity,
        id: resolvePrimaryKey(args.entity),
        changes: args.changeSet?.payload ?? null,
      };
      const input: RecordInput<ModelEntryContent> = {
        type: EntryType.Model,
        familyHash: `model:${entity}:${action}`,
        tags: ['model', `model:${action}`, `entity:${entity}`],
        content,
      };
      ctx.record(input);
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.logger.error(`MikroOrmModelWatcher: failed to record model change: ${message}`);
    }
  }

  /** Record a flush lifecycle entry with measured duration. */
  private safeRecordFlush(ctx: WatcherContext, durationMs: number | null): void {
    try {
      const content: FlushEntryContent = { kind: 'flush' };
      const input: RecordInput<FlushEntryContent> = {
        type: EntryType.Model,
        familyHash: 'model:flush',
        tags: ['model', 'model:flush'],
        content,
        durationMs,
      };
      ctx.record(input);
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.logger.error(`MikroOrmModelWatcher: failed to record flush: ${message}`);
    }
  }

  /** Record a transaction lifecycle entry with measured duration and outcome. */
  private safeRecordTransaction(
    ctx: WatcherContext,
    outcome: 'committed' | 'rolled-back',
    durationMs: number | null,
  ): void {
    try {
      const content: TransactionEntryContent = { kind: 'transaction', outcome };
      const input: RecordInput<TransactionEntryContent> = {
        type: EntryType.Model,
        familyHash: `model:transaction:${outcome}`,
        tags: ['model', 'model:transaction', `transaction:${outcome}`],
        content,
        durationMs,
      };
      ctx.record(input);
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.logger.error(`MikroOrmModelWatcher: failed to record transaction: ${message}`);
    }
  }
}
