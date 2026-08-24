import type { Entry, TelescopeExtension } from '@dudousxd/nestjs-telescope';
import type { AssembledBatch } from './assemble/assembled-batch.js';
import { BatchAssembler } from './assemble/batch-assembler.js';
import { shouldExportBatch } from './batch-sampling.js';
import { encodeJob } from './encode/job.encoder.js';
import { encodeLog } from './encode/log.encoder.js';
import { encodeSnapshot } from './encode/snapshot.encoder.js';
import { EntryMetrics } from './metrics/entry-metrics.js';
import {
  type ObserveExporterOptions,
  type ResolvedObserveOptions,
  resolveObserveOptions,
} from './observe-options.js';
import { RuntimeCollector } from './runtime/runtime-collector.js';
import { ObserveTransport } from './transport/observe-transport.js';
import type {
  WireCustomMetric,
  WireJob,
  WireLog,
  WireRuntimeMetrics,
  WireSnapshot,
  WireTelemetryBatch,
} from './wire/telemetry-wire.js';

/** Counters for answering "why is nothing arriving in Observe?" without a debugger. */
export interface ObserveExporterMetrics {
  entriesAccepted: number;
  entriesFiltered: number;
  batchesEncoded: number;
  batchesSampledOut: number;
  snapshotsSent: number;
  jobsSent: number;
  logsSent: number;
  recordsDroppedOverCap: number;
  runtimeSnapshotsSent: number;
  customMetricsSent: number;
  droppedSeries: number;
  openBatches: number;
  transportDisabled: boolean;
}

/**
 * Forwards Telescope entries to NestJS Observe.
 *
 * Register it as an extension:
 *
 * ```ts
 * TelescopeModule.forRoot({ extensions: [new ObserveExporter({ appKey, appSecret, serviceId })] })
 * ```
 *
 * Two properties of the host shape this class. `observeFlush` is awaited inside
 * the Recorder's flush chain, so it may only buffer — every encode and every
 * POST happens on this exporter's own timer instead. And the hook fires only for
 * flushes that actually persisted something, so an idle application never calls
 * it; without an independent timer the last batches of a traffic burst would sit
 * in the assembler until the next request arrived.
 */
export class ObserveExporter implements TelescopeExtension {
  readonly name = 'observe-export';

  private readonly options: ResolvedObserveOptions;
  private readonly assembler: BatchAssembler;
  private readonly transport: ObserveTransport;
  private readonly pendingLogs: WireLog[] = [];
  private readonly snapshots: WireSnapshot[] = [];
  private readonly jobs: WireJob[] = [];
  private readonly runtimeCollector: RuntimeCollector | null;
  private readonly entryMetrics: EntryMetrics | null;
  /** Zero so the first flush carries a snapshot — an empty Profiler for a minute reads as broken. */
  private lastRuntimeAt = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  /** One POST at a time: overlapping ticks would reorder batches and multiply load during an outage. */
  private sending = false;
  private closed = false;
  private readonly counters = {
    entriesAccepted: 0,
    entriesFiltered: 0,
    batchesEncoded: 0,
    batchesSampledOut: 0,
    snapshotsSent: 0,
    jobsSent: 0,
    logsSent: 0,
    recordsDroppedOverCap: 0,
    runtimeSnapshotsSent: 0,
    customMetricsSent: 0,
  };

  constructor(options: ObserveExporterOptions) {
    this.options = resolveObserveOptions(options);
    this.assembler = new BatchAssembler(this.options);
    this.transport = new ObserveTransport(this.options);
    this.runtimeCollector = this.options.include.runtime
      ? new RuntimeCollector({ clock: this.options.clock, logger: this.options.logger })
      : null;
    this.runtimeCollector?.start();
    this.entryMetrics = this.options.include.metrics
      ? new EntryMetrics({
          clock: this.options.clock,
          maxSeriesPerMetric: this.options.maxSeriesPerMetric,
        })
      : null;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.flushIntervalMs);
    // Never hold the process open: telemetry export must not be the reason a CLI
    // or a finished test run refuses to exit.
    this.timer.unref?.();
  }

  /**
   * Fired for EVERY record before sampling, which is the point: a counter built
   * from the post-sampling flush would report whatever survived, not what happened.
   */
  observeRecord(input: Parameters<NonNullable<TelescopeExtension['observeRecord']>>[0]): void {
    if (this.closed) return;
    this.entryMetrics?.observe(input);
  }

  observeFlush(entries: Entry[]): void {
    if (this.closed || this.transport.disabled) return;
    const accepted: Entry[] = [];
    for (const entry of entries) {
      if (this.isExportable(entry)) {
        accepted.push(entry);
      } else {
        this.counters.entriesFiltered += 1;
      }
    }
    this.counters.entriesAccepted += accepted.length;
    this.assembler.add(accepted);
  }

  /** Stops the timer and makes a final best-effort send of everything still held. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.dispatch(this.assembler.drainAll());
    this.runtimeCollector?.stop();
  }

  get metrics(): ObserveExporterMetrics {
    return {
      ...this.counters,
      droppedSeries: this.entryMetrics?.droppedSeries ?? 0,
      openBatches: this.assembler.openCount,
      transportDisabled: this.transport.disabled,
    };
  }

  /** `include` decides the section, the host `filter` gets the last word. */
  private isExportable(entry: Entry): boolean {
    const { include } = this.options;
    if (entry.type === 'log' && !include.logs) return false;
    if (entry.type === 'request' && !include.requests) return false;
    if ((entry.type === 'job' || entry.type === 'schedule') && !include.jobs) return false;
    if (this.options.filter !== undefined && !this.options.filter(entry)) return false;
    return true;
  }

  private async tick(): Promise<void> {
    if (this.sending || this.closed || this.transport.disabled) return;
    await this.dispatch(this.assembler.drain());
  }

  private async dispatch(batches: AssembledBatch[]): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      this.collect(batches);
      for (const payload of this.buildPayloads()) {
        const accepted = await this.transport.send(payload);
        // A rejected payload is not requeued: the transport already retried what
        // could succeed later, and holding failed telemetry would trade the
        // application's memory for records the collector has refused.
        if (!accepted && this.transport.disabled) break;
      }
    } finally {
      this.sending = false;
    }
  }

  /** Encode ripe batches into the three wire sections, applying batch-level sampling. */
  private collect(batches: AssembledBatch[]): void {
    for (const batch of batches) {
      if (!shouldExportBatch(batch, this.options.sampleRate)) {
        this.counters.batchesSampledOut += 1;
        continue;
      }
      this.counters.batchesEncoded += 1;

      if (this.options.include.logs) {
        for (const child of batch.children) {
          if (child.type !== 'log') continue;
          const log = encodeLog(child);
          if (log !== null) this.push(this.pendingLogs, log, this.options.maxLogsPerRequest * 4);
        }
      }

      const snapshot = this.options.include.requests ? encodeSnapshot(batch, this.options) : null;
      if (snapshot !== null) {
        this.push(this.snapshots, snapshot, this.options.maxRecordsPerRequest * 4);
        continue;
      }
      const job = this.options.include.jobs ? encodeJob(batch, this.options) : null;
      if (job !== null) this.push(this.jobs, job, this.options.maxRecordsPerRequest * 4);
    }
  }

  /**
   * Bounded append. The cap is a multiple of the per-request ceiling so a burst
   * spanning a few ticks still drains, while an unreachable collector cannot
   * grow these arrays without limit.
   */
  private push<T>(target: T[], value: T, cap: number): void {
    if (target.length >= cap) {
      this.counters.recordsDroppedOverCap += 1;
      return;
    }
    target.push(value);
  }

  /** Slices the buffered sections into POST-sized payloads, draining as it goes. */
  private buildPayloads(): WireTelemetryBatch[] {
    const payloads: WireTelemetryBatch[] = [];
    const hasTraffic =
      this.snapshots.length > 0 || this.jobs.length > 0 || this.pendingLogs.length > 0;
    const runtime = this.dueRuntime();
    // Metrics ride whatever is already leaving, so they stay timely under load.
    // With nothing to ride they wait for the runtime heartbeat instead of
    // posting a cumulative counter every flush — an idle process would
    // otherwise POST twelve times a minute to say nothing changed.
    const custom = hasTraffic || runtime !== null ? this.dueCustomMetrics() : [];

    while (this.snapshots.length > 0 || this.jobs.length > 0 || this.pendingLogs.length > 0) {
      const snapshots = this.snapshots.splice(0, this.options.maxRecordsPerRequest);
      const jobs = this.jobs.splice(0, this.options.maxRecordsPerRequest);
      const logs = this.pendingLogs.splice(0, this.options.maxLogsPerRequest);

      this.counters.snapshotsSent += snapshots.length;
      this.counters.jobsSent += jobs.length;
      this.counters.logsSent += logs.length;

      // Omitted rather than empty: the collector's allowlist accepts absent
      // sections, and an empty array is payload spent on nothing.
      payloads.push({
        ...this.envelope(),
        ...(snapshots.length > 0 ? { snapshots } : {}),
        ...(jobs.length > 0 ? { jobs } : {}),
        ...(logs.length > 0 ? { logs } : {}),
      });
    }

    // A quiet process still has a heartbeat worth reporting, so runtime and
    // metrics can be the only reason to POST at all.
    if (payloads.length === 0 && (runtime !== null || custom.length > 0)) {
      payloads.push(this.envelope());
    }

    // Both ride on the FIRST payload only. `runtime` is a single object the
    // collector overwrites per batch, and `custom` carries an interval delta —
    // repeating either across a split would double-count it.
    const first = payloads[0];
    if (first !== undefined) {
      if (runtime !== null) {
        first.runtime = runtime;
        this.counters.runtimeSnapshotsSent += 1;
      }
      if (custom.length > 0) {
        first.custom = custom;
        this.counters.customMetricsSent += custom.length;
      }
    }
    return payloads;
  }

  private envelope(): WireTelemetryBatch {
    return {
      serviceId: this.options.serviceId,
      ...(this.options.serviceVersion !== undefined
        ? { serviceVersion: this.options.serviceVersion }
        : {}),
      ...(this.options.include.logs ? { forwardLogs: true } : {}),
    };
  }

  /** A process snapshot, at most once per `runtimeIntervalMs`. */
  private dueRuntime(): WireRuntimeMetrics | null {
    if (this.runtimeCollector === null) return null;
    const now = this.options.clock();
    if (now - this.lastRuntimeAt < this.options.runtimeIntervalMs) return null;
    const snapshot = this.runtimeCollector.collect();
    // The interval is only consumed by a snapshot that exists. An incomplete
    // reading — which is what the very first one usually is, before the
    // event-loop histogram has a sample — retries on the next flush instead of
    // costing a minute of silence.
    if (snapshot !== null) this.lastRuntimeAt = now;
    return snapshot;
  }

  private dueCustomMetrics(): WireCustomMetric[] {
    return this.entryMetrics?.collect() ?? [];
  }
}

/** Convenience factory, mirroring the other Telescope integration packages. */
export function observeExporter(options: ObserveExporterOptions): ObserveExporter {
  return new ObserveExporter(options);
}
