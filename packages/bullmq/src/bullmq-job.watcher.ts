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
      const instance = wrapper.instance as unknown;
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
          watcher.record(
            ctx,
            job as JobLike,
            'completed',
            watcher.clock.now() - startedAt,
            undefined,
          );
          return result;
        } catch (error) {
          watcher.record(ctx, job as JobLike, 'failed', watcher.clock.now() - startedAt, error);
          throw error;
        }
      });
    };
  }

  private record(
    ctx: WatcherContext,
    job: JobLike,
    status: JobStatus,
    durationMs: number,
    error: unknown,
  ): void {
    const content = buildJobContent(job, status, error, this.includeJobData);
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
  }
}
