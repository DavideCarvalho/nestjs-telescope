// packages/bullmq/src/bullmq-job.watcher.ts
import {
  EntryType,
  type RecordInput,
  type Watcher,
  type WatcherContext,
} from '@dudousxd/nestjs-telescope';
import { WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { type JobLike, type JobStatus, buildJobContent } from './job-content.js';

export interface BullMqJobWatcherOptions {
  /** Jobs whose processing time is >= this (ms) get a 'slow' tag. Default 1000. */
  slowMs?: number;
  /** Capture `job.data` as the entry payload. Default true (core redaction applies). */
  includeJobData?: boolean;
  /** Time source; injectable for tests. Default wall clock. */
  clock?: { now(): number };
}

/** The prototype-level method we patch. `process(job, token?)` per BullMQ. */
type ProcessHost = { process: (job: unknown, token?: string) => Promise<unknown> };

/** Narrow an unknown BullMQ job to the structural `JobLike` we read. Every field
 *  is accessed defensively in `buildJobContent`, so a non-object degrades to {}. */
function toJobLike(job: unknown): JobLike {
  return typeof job === 'object' && job !== null ? (job as JobLike) : {};
}

/**
 * Captures BullMQ jobs and correlates each job's queries/exceptions to its batch.
 *
 * ## How it works
 * At registration the watcher uses NestJS `DiscoveryService` to find every
 * `WorkerHost` provider and replaces its subclass-prototype `process` method
 * with a wrapper that runs the original inside `ctx.runInBatch('queue', ...)`.
 *
 * `@nestjs/bullmq` resolves `instance.process(job, token)` at call-time per job
 * (to support request-scoped processors), and jobs only run after the app has
 * bootstrapped -- so a prototype patch applied during `register()` (which the
 * registrar invokes at `onApplicationBootstrap`) always precedes the first job.
 *
 * The wrapper never swallows the host's error: on failure it records a `failed`
 * job entry and re-throws so BullMQ's own retry/lifecycle is unaffected.
 *
 * @remarks
 * Processor detection uses `instanceof WorkerHost`. If the host application
 * resolves two distinct copies of `@nestjs/bullmq` in its module tree,
 * processors from the other copy won't match and will be left un-instrumented
 * (surfaced only by the "no processors found" warning). A single, deduped
 * `@nestjs/bullmq` is assumed.
 */
export class BullMqJobWatcher implements Watcher {
  readonly type = EntryType.Job;
  private readonly logger = new Logger(BullMqJobWatcher.name);
  private readonly slowMs: number;
  private readonly includeJobData: boolean;
  private readonly clock: { now(): number };
  /** Prototypes already patched, so shared prototypes wrap exactly once. */
  private readonly patched = new WeakSet<object>();

  constructor(options: BullMqJobWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? 1000;
    this.includeJobData = options.includeJobData ?? true;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  async register(ctx: WatcherContext): Promise<void> {
    const discovery = ctx.moduleRef.get(DiscoveryService, { strict: false });
    let count = 0;
    for (const wrapper of discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (!(instance instanceof WorkerHost)) continue;
      const proto = Object.getPrototypeOf(instance) as object;
      if (this.patched.has(proto)) continue;
      this.patched.add(proto);
      this.patchProcess(proto as ProcessHost, ctx);
      count++;
    }
    if (count === 0) {
      this.logger.warn(
        'BullMqJobWatcher: no @Processor (WorkerHost) providers found. ' +
          'Jobs will not be captured. Ensure your processors are registered before Telescope bootstraps.',
      );
    } else {
      this.logger.log(`BullMqJobWatcher: instrumented ${count} processor class(es).`);
    }
  }

  private patchProcess(proto: ProcessHost, ctx: WatcherContext): void {
    const original = proto.process;
    if (typeof original !== 'function') return;
    const watcher = this;

    proto.process = function patchedProcess(
      this: unknown,
      job: unknown,
      token?: string,
    ): Promise<unknown> {
      return ctx.runInBatch('queue', async () => {
        const startedAt = watcher.clock.now();
        try {
          const result = await original.call(this, job, token);
          // safeRecord never throws, so a telescope failure cannot turn a
          // successful job into a failed one.
          watcher.safeRecord(ctx, job, 'completed', watcher.clock.now() - startedAt, undefined);
          return result;
        } catch (error) {
          watcher.safeRecord(ctx, job, 'failed', watcher.clock.now() - startedAt, error);
          watcher.safeRecordException(ctx, job, error);
          throw error; // never swallow the host's error
        }
      });
    };
  }

  /**
   * Turn the job's throw into an `exception` entry, in the job's own batch.
   *
   * WHY this is not redundant with the `failed` job entry above: that entry
   * carries the failure only as a `failureReason` string on its content. It
   * opens no exception family, so a job that has been failing all night never
   * fires `new-exception`, never gets an AI diagnosis, and never shows up in the
   * exceptions view — the throw is observable only if someone happens to open
   * that job. `ctx.recordException` routes through the SAME capture the Nest
   * interceptor uses, so a `TypeError` thrown in a job groups with the identical
   * `TypeError` thrown in a request, and a 4xx `HttpException` re-used by a
   * worker is skipped by the same control-flow policy.
   *
   * Guarded twice over: the `typeof` check keeps the watcher working against a
   * `WatcherContext` from an older core (or a hand-rolled one in a host's
   * tests), and the try/catch means a failure while building the context object
   * can never turn into a second throw on the host's own failure path.
   */
  private safeRecordException(ctx: WatcherContext, job: unknown, error: unknown): void {
    try {
      if (typeof ctx.recordException !== 'function') return;
      const jobLike = toJobLike(job);
      const queue = jobLike.queueName ?? '';
      const name = jobLike.name ?? '';
      const tags: string[] = [];
      if (queue) tags.push(`queue:${queue}`);
      if (name) tags.push(`job:${name}`);
      ctx.recordException(error, {
        // Off the request path there is no sibling `request` entry naming the
        // unit of work, so the exception has to carry that itself.
        context: {
          queue,
          job: name,
          jobId: jobLike.id != null ? String(jobLike.id) : null,
          attempts: typeof jobLike.attemptsMade === 'number' ? jobLike.attemptsMade : 0,
        },
        tags,
      });
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.logger.error(`BullMqJobWatcher: failed to record job exception: ${message}`);
    }
  }

  /** Build + hand a job entry to the Recorder, swallowing any failure. Core's
   *  record() is already non-throwing; this double-guard keeps the watcher safe
   *  even against a custom or regressed WatcherContext, so recording can never
   *  alter the host job's outcome. */
  private safeRecord(
    ctx: WatcherContext,
    job: unknown,
    status: JobStatus,
    durationMs: number,
    error: unknown,
  ): void {
    try {
      const content = buildJobContent(toJobLike(job), status, error, this.includeJobData);
      const familyHash = [content.queue, content.name].filter(Boolean).join(':') || null;

      const tags: string[] = [];
      if (content.queue) tags.push(`queue:${content.queue}`);
      if (content.name) tags.push(`job:${content.name}`);
      if (status === 'failed') tags.push('failed');
      if (durationMs >= this.slowMs) tags.push('slow');

      const input: RecordInput = {
        type: EntryType.Job,
        content,
        familyHash,
        durationMs,
      };
      if (tags.length > 0) input.tags = tags;
      ctx.record(input);
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.logger.error(`BullMqJobWatcher: failed to record job entry: ${message}`);
    }
  }
}
