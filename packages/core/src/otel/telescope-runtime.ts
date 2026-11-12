// packages/core/src/otel/telescope-runtime.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RecordInput } from '../entry/entry.js';

/**
 * The bridge between a booted Telescope and code that runs outside Nest DI, chiefly
 * `telescopeSpanProcessor()` from `@dudousxd/nestjs-telescope-otel/span-processor`. That
 * processor is built in the app's OpenTelemetry bootstrap file, before Nest (or this package)
 * loads, so it reads this state from a `Symbol.for()` global slot instead of importing it.
 * Two copies of this package in one process share the slot too.
 *
 * Everything here is internal plumbing. The shape is the contract between core and the otel
 * package, so it only grows.
 */

/** Global slot holding the {@link TelescopeRuntime}. */
export const TELESCOPE_RUNTIME_KEY = Symbol.for('@dudousxd/nestjs-telescope:runtime');

/** Global flag `telescopeSpanProcessor()` sets, so the dashboard lists `span` entries. */
export const TELESCOPE_SPAN_PROCESSOR_KEY = Symbol.for('@dudousxd/nestjs-telescope:span-processor');

/**
 * Operations a Telescope watcher records itself, so the span processor skips the OpenTelemetry
 * spans for the same operation:
 * - `request`: incoming HTTP (the request middleware).
 * - `query`: SQL (the TypeORM logger, the MikroORM and Prisma watchers).
 * - `redis`: redis commands (the redis watcher).
 * - `http-client`: outgoing `fetch` and axios calls through the http-client watcher. Matched per
 *   call (see {@link runCoveredByTelescope}), so calls the watcher doesn't see still come through.
 */
export type CoveredOperation = 'request' | 'query' | 'redis' | 'http-client';

/** Entry type each covered operation's watcher records. */
const ENTRY_TYPE_BY_OPERATION: Readonly<Record<CoveredOperation, string>> = {
  request: 'request',
  query: 'query',
  redis: 'redis',
  'http-client': 'http_client',
};

const OPERATION_BY_ENTRY_TYPE = new Map<string, CoveredOperation>(
  Object.entries(ENTRY_TYPE_BY_OPERATION).map(([operation, type]) => [
    type,
    operation as CoveredOperation,
  ]),
);

/**
 * Told, for each entry a covering watcher hands to the recorder, whether sampling kept it.
 * `traceKey` is the OpenTelemetry trace id active when the watcher recorded, or `''` outside
 * any span. Installed by the span processor under {@link TELESCOPE_COVERED_OUTCOME_KEY}.
 */
export type CoveredOutcomeListener = (
  operation: CoveredOperation,
  traceKey: string,
  kept: boolean,
) => void;

/** Global slot holding the {@link CoveredOutcomeListener}. */
export const TELESCOPE_COVERED_OUTCOME_KEY = Symbol.for(
  '@dudousxd/nestjs-telescope:covered-outcome',
);

/** @internal State shared through {@link TELESCOPE_RUNTIME_KEY}. */
export interface TelescopeRuntime {
  /** Hands an entry to the booted Telescope. `null` before boot and after shutdown. */
  record: ((input: RecordInput) => void) | null;
  /** Whether ingestion is paused by the overload guard. */
  isPaused(): boolean;
  /** Dashboard mount path with a leading slash (`/telescope`). `null` before boot. */
  selfPath: string | null;
  /** Operations a watcher records, with how many watchers currently record each. */
  readonly covered: Map<CoveredOperation, number>;
  /** Whether the caller is inside {@link runAsTelescopeWork}. */
  isTelescopeWork(): boolean;
  /** Whether the caller is inside {@link runCoveredByTelescope} (an outgoing call the watcher records). */
  isCoveredCall(): boolean;
  /**
   * Whether sampling can drop entries the watcher for `operation` records. When it can, the
   * span processor holds that operation's spans until the watcher's entry is kept or dropped
   * (see {@link reportCoveredOutcome}). Absent on a runtime created by an older core.
   */
  isSampled?(operation: CoveredOperation): boolean;
  /**
   * The active Telescope batch, captured when a span starts, so a span that ends outside it
   * (an ioredis reply callback) still records into its request's batch. Absent on older cores.
   */
  captureBatch?(): unknown;
  /** Record `input` inside a batch from {@link captureBatch}. Absent on older cores. */
  recordInBatch?(batch: unknown, input: RecordInput): void;
}

const globalSlot = globalThis as Record<symbol, unknown>;

const SELF_SCOPE_KEY = Symbol.for('@dudousxd/nestjs-telescope:self-scope');
const COVERED_CALL_KEY = Symbol.for('@dudousxd/nestjs-telescope:covered-call');

function sharedStorage(key: symbol): AsyncLocalStorage<true> {
  const existing = globalSlot[key] as AsyncLocalStorage<true> | undefined;
  if (existing !== undefined) return existing;
  const created = new AsyncLocalStorage<true>();
  globalSlot[key] = created;
  return created;
}

const selfScope = sharedStorage(SELF_SCOPE_KEY);
const coveredCall = sharedStorage(COVERED_CALL_KEY);

/** The runtime in the global slot, created on first use. */
export function telescopeRuntime(): TelescopeRuntime {
  const existing = globalSlot[TELESCOPE_RUNTIME_KEY] as TelescopeRuntime | undefined;
  if (existing !== undefined) return existing;
  const created: TelescopeRuntime = {
    record: null,
    isPaused: () => false,
    selfPath: null,
    covered: new Map(),
    isTelescopeWork: () => selfScope.getStore() === true,
    isCoveredCall: () => coveredCall.getStore() === true,
    isSampled: () => false,
  };
  globalSlot[TELESCOPE_RUNTIME_KEY] = created;
  return created;
}

/**
 * Declare that a watcher records `operation`. Returns the matching release, for a watcher's
 * `unregister()`. Calls stack: the operation stays covered while any watcher holds it.
 */
export function markCoveredByTelescope(operation: CoveredOperation): () => void {
  const covered = telescopeRuntime().covered;
  covered.set(operation, (covered.get(operation) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (covered.get(operation) ?? 1) - 1;
    if (count <= 0) covered.delete(operation);
    else covered.set(operation, count);
  };
}

/** Whether the span processor has been built in this process. */
export function isTelescopeSpanProcessorActive(): boolean {
  return globalSlot[TELESCOPE_SPAN_PROCESSOR_KEY] === true;
}

/**
 * `@opentelemetry/api` registers its globals under `Symbol.for('opentelemetry.js.api.<major>')`.
 * Telescope has no `@opentelemetry/api` dependency, so the app may run any major: match them all.
 */
const OTEL_API_KEY_PATTERN = /^opentelemetry\.js\.api\.(\d+)$/;
/**
 * The context key OpenTelemetry instrumentations read to skip tracing (`suppressTracing` in
 * `@opentelemetry/core`). `createContextKey` is `Symbol.for(description)`, so this is the same
 * key without depending on any OpenTelemetry package.
 */
const SUPPRESS_TRACING_KEY = Symbol.for('OpenTelemetry SDK Context Key SUPPRESS_TRACING');

interface ContextLike {
  setValue(key: symbol, value: unknown): ContextLike;
  getValue?(key: symbol): unknown;
}

/** The context key `@opentelemetry/api` stores the active span under (`trace.setSpan`). */
const ACTIVE_SPAN_KEY = Symbol.for('OpenTelemetry Context Key SPAN');
interface ContextManagerLike {
  active(): ContextLike;
  with<T>(context: ContextLike, fn: () => T): T;
}

/**
 * Run `fn` with OpenTelemetry tracing suppressed when an SDK registered a global context
 * manager, so Telescope's own storage queries make no spans in the app's traces. Without an SDK
 * it just runs `fn`.
 */
function withoutTracing<T>(fn: () => T): T {
  const manager = globalContextManager();
  if (manager === undefined) return fn();
  return manager.with(manager.active().setValue(SUPPRESS_TRACING_KEY, true), fn);
}

/** The context manager of the highest `@opentelemetry/api` major registered in this process. */
function globalContextManager(): ContextManagerLike | undefined {
  let found: ContextManagerLike | undefined;
  let foundMajor = -1;
  for (const key of Object.getOwnPropertySymbols(globalSlot)) {
    const match = OTEL_API_KEY_PATTERN.exec(key.description ?? '');
    if (match === null || Symbol.for(key.description ?? '') !== key) continue;
    const major = Number(match[1]);
    if (major <= foundMajor) continue;
    const manager = (globalSlot[key] as { context?: Partial<ContextManagerLike> } | undefined)
      ?.context;
    if (typeof manager?.with !== 'function' || typeof manager.active !== 'function') continue;
    found = manager as ContextManagerLike;
    foundMajor = major;
  }
  return found;
}

/** Trace id of the active OpenTelemetry span, or `null` without an SDK or outside any span. */
function activeTraceId(): string | null {
  try {
    const span = globalContextManager()?.active().getValue?.(ACTIVE_SPAN_KEY) as
      | { spanContext?: () => { traceId?: unknown } }
      | undefined;
    const traceId = span?.spanContext?.().traceId;
    return typeof traceId === 'string' ? traceId : null;
  } catch {
    return null;
  }
}

/**
 * Tell the span processor whether sampling kept an entry a covering watcher recorded, so it
 * shows the matching OpenTelemetry span only when the entry was dropped. Called by the
 * recorder for every sampled entry; a no-op without a span processor or for other types.
 */
export function reportCoveredOutcome(type: string, kept: boolean): void {
  if (!isTelescopeSpanProcessorActive()) return;
  const operation = OPERATION_BY_ENTRY_TYPE.get(type);
  if (operation === undefined) return;
  const listener = globalSlot[TELESCOPE_COVERED_OUTCOME_KEY];
  if (typeof listener !== 'function') return;
  (listener as CoveredOutcomeListener)(operation, activeTraceId() ?? '', kept);
}

/** Entry type the watcher for `operation` records. */
export function coveredEntryType(operation: CoveredOperation): string {
  return ENTRY_TYPE_BY_OPERATION[operation];
}

/**
 * Run `fn` as Telescope's own work (storage reads, writes, prunes): no OpenTelemetry spans are
 * made for it and the span processor records nothing from it.
 */
export function runAsTelescopeWork<T>(fn: () => T): T {
  return selfScope.run(true, () => withoutTracing(fn));
}

/** Whether the caller is inside {@link runAsTelescopeWork}. */
export function isTelescopeWork(): boolean {
  return selfScope.getStore() === true;
}

/** Run `fn` as an outgoing call a watcher records itself (an instrumented `fetch` or axios request). */
export function runCoveredByTelescope<T>(fn: () => T): T {
  return coveredCall.run(true, fn);
}

/**
 * Wrap a storage provider so every method call runs as {@link runAsTelescopeWork}. The target
 * stays the receiver, so providers using `#private` fields keep working.
 */
export function asTelescopeWorkStorage<T extends object>(storage: T): T {
  const wrapped = new WeakMap<object, unknown>();
  return new Proxy(storage, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || prop === 'constructor') return value;
      const cached = wrapped.get(value);
      if (cached !== undefined) return cached;
      const fn = value as (...args: unknown[]) => unknown;
      const bound = (...args: unknown[]) => runAsTelescopeWork(() => fn.apply(target, args));
      wrapped.set(value, bound);
      return bound;
    },
  });
}
