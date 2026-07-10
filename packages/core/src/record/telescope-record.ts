// packages/core/src/record/telescope-record.ts
import type { RecordInput } from '../entry/entry.js';

/**
 * A free-function record sink for boot-time integrations that need to emit
 * Telescope entries before Nest DI has constructed `TelescopeService` — most
 * notably a MikroORM query logger, which MikroORM constructs (and can start
 * calling) at `MikroORM.init()`, well before `TelescopeModule` has wired
 * anything. `telescopeRecord` forwards to a module-level sink that
 * `TelescopeService`'s constructor binds automatically (and
 * `onApplicationShutdown` clears) — mirrors `telescopeDump`'s pattern
 * (`../dump/telescope-dump.js`).
 *
 * Entries emitted before the sink is bound — or after it's cleared — are
 * DROPPED, not queued: there is no unbounded buffer waiting to replay boot
 * noise once the module comes up. That's by design: buffering until bound
 * risks unbounded memory growth if `TelescopeModule` is never imported, or
 * takes a long time to boot. Boot noise is expected to be dropped, not
 * delayed.
 */

type RecordSink = (input: RecordInput) => void;

let sink: RecordSink | null = null;

/**
 * Re-entrancy guard, mirroring `log-sink.ts`. `TelescopeService.record()`
 * flushes through the Recorder into the configured `StorageProvider`; the
 * MikroORM storage provider issues its OWN queries through a dedicated,
 * isolated-`contextName` MikroORM instance (see
 * `mikro-orm-storage.provider.ts`) — NOT the host's ORM that
 * `telescopeMikroOrmLogger` is normally wired into. So in practice a
 * `record()` call shouldn't loop back into `telescopeRecord()`. The guard is
 * kept anyway — cheap, and it protects a host that (unusually) reuses the
 * same ORM/logger for both app queries and Telescope's own storage from
 * recursing into `record()` from inside `record()`.
 * @internal
 */
let recordingInProgress = false;

/**
 * Install (or clear, with `null`) the record sink. Called by
 * `TelescopeService`'s lifecycle (constructor binds, shutdown clears) —
 * hosts should not call this directly; it's also usable by tests/hosts that
 * need to override the bound sink explicitly.
 */
export function setTelescopeRecordSink(fn: RecordSink | null): void {
  sink = fn;
}

/**
 * Forward a boot-time record to the installed sink. A no-op — never throws,
 * never buffers — until `TelescopeModule` has wired the sink (or after it's
 * cleared on shutdown). Safe to call from anywhere, including code paths
 * that run before Nest DI exists (ORM loggers, process hooks).
 */
export function telescopeRecord(input: RecordInput): void {
  if (sink === null || recordingInProgress) return;
  recordingInProgress = true;
  try {
    sink(input);
  } finally {
    recordingInProgress = false;
  }
}
