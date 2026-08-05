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
import {
  type JobRunner,
  type ProcessorInstrumentation,
  bindJobRunner,
  installProcessorInstrumentation,
  instrumentProcessor,
  isInstrumentedProcessor,
} from './processor-instrumentation.js';

export interface BullMqJobWatcherOptions {
  /** Jobs whose processing time is >= this (ms) get a 'slow' tag. Default 1000. */
  slowMs?: number;
  /** Capture `job.data` as the entry payload. Default true (core redaction applies). */
  includeJobData?: boolean;
  /** Time source; injectable for tests. Default wall clock. */
  clock?: { now(): number };
}

/** Every `JobLike` field is optional and read defensively in `buildJobContent`,
 *  so any object qualifies and a non-object degrades to {}. */
function isJobLike(value: unknown): value is JobLike {
  return typeof value === 'object' && value !== null;
}

/** Narrow an unknown BullMQ job to the structural `JobLike` we read. */
function toJobLike(job: unknown): JobLike {
  return isJobLike(job) ? job : {};
}

/** The BullMQ `Worker` field the fallback path re-points: the function
 *  `callProcessJob` reads on every job (`return this.processFn(job, token, …)`). */
interface WorkerLike {
  processFn: (...args: unknown[]) => unknown;
}

function isWorkerLike(value: unknown): value is WorkerLike {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'processFn') === 'function';
}

/**
 * Captures BullMQ jobs and correlates each job's queries/exceptions to its batch.
 *
 * ## How it works
 * The watcher's CONSTRUCTOR patches `ProcessorDecoratorService.prototype.decorate`
 * — `@nestjs/bullmq`'s own processor-wrapping extension point — so the function
 * the framework hands to `new Worker(...)` is already a Telescope wrapper. See
 * `processor-instrumentation.ts` for why the seam is there and not on the
 * processor's prototype: the explorer binds `instance.process` ONCE at
 * `onModuleInit`, so a prototype patch applied at `onApplicationBootstrap` (when
 * Telescope registers its watchers) is never seen by the worker again. That was
 * this watcher's previous strategy, and against a real Redis it captured
 * literally nothing — no `job` entry, no exception, no batch.
 *
 * `register()` then points that seam at the live `WatcherContext`. The binding
 * is deliberately late: a job that manages to run before Telescope registers
 * calls the processor straight through rather than waiting on it.
 *
 * Both of the framework's branches are covered — a static processor (decorated
 * once at `onModuleInit`) and a request-scoped one (decorated per job, around
 * the instance resolved for that job's context).
 *
 * The wrapper never swallows the host's error: on failure it records a `failed`
 * job entry and re-throws so BullMQ's own retry/lifecycle is unaffected.
 *
 * @remarks
 * If the installed `@nestjs/bullmq` predates the decorator seam, or the host
 * replaced `ProcessorDecoratorService` with its own subclass, `register()` says
 * so in a warning naming the version and falls back to re-pointing
 * `worker.processFn` on each discovered `WorkerHost`. The fallback runs at
 * `onApplicationBootstrap`, after the workers have already started, so jobs
 * picked up in that window are not captured — the warning names that too.
 * Whichever path is taken, silence is not one of the options.
 */
export class BullMqJobWatcher implements Watcher {
  readonly type = EntryType.Job;
  private readonly logger = new Logger(BullMqJobWatcher.name);
  private readonly slowMs: number;
  private readonly includeJobData: boolean;
  private readonly clock: { now(): number };
  private readonly instrumentation: ProcessorInstrumentation;
  /**
   * Processors the seam had already wrapped when `register()` ran. A non-zero
   * count is the machine-checkable proof that instrumentation preceded the
   * framework's explorer; a regression to late patching drives it to zero.
   */
  private wrappedBeforeRegister = 0;

  constructor(options: BullMqJobWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? 1000;
    this.includeJobData = options.includeJobData ?? true;
    this.clock = options.clock ?? { now: () => Date.now() };
    // Runs while the host is still building its module metadata — before
    // NestFactory.create, therefore before BullRegistrar.onModuleInit.
    this.instrumentation = installProcessorInstrumentation();
  }

  /** Processors instrumented before `register()` ran. Read by the ordering
   *  regression test; carries no meaning for request-scoped processors, which
   *  the framework decorates per job. */
  get instrumentedBeforeRegister(): number {
    return this.wrappedBeforeRegister;
  }

  async register(ctx: WatcherContext): Promise<void> {
    const runner: JobRunner = (job, invoke) => this.runJob(ctx, job, invoke);
    const processors = this.discoverProcessors(ctx);
    const host = this.resolveSeamHost(ctx);

    if (host) {
      this.wrappedBeforeRegister = bindJobRunner(host, runner);
    } else {
      const fallback = this.instrumentWorkers(processors, runner);
      const reason =
        this.instrumentation.reason ??
        'the resolved ProcessorDecoratorService is not the one Telescope patched (replaced by the host?)';
      this.logger.warn(
        `BullMqJobWatcher: ${reason}. Fell back to instrumenting ${fallback} running worker(s) — jobs picked up before the app finished bootstrapping are NOT captured.`,
      );
    }

    if (processors.length === 0) {
      this.logger.warn(
        'BullMqJobWatcher: no @Processor (WorkerHost) providers found. ' +
          'Jobs will not be captured. Ensure BullModule and your processors are part of the module tree.',
      );
      return;
    }
    this.logger.log(`BullMqJobWatcher: watching ${processors.length} processor class(es).`);
  }

  /** Every `WorkerHost` provider in the graph — used for the boot warning and,
   *  when the seam is unavailable, as the fallback's list of workers. */
  private discoverProcessors(ctx: WatcherContext): unknown[] {
    try {
      const discovery = ctx.moduleRef.get(DiscoveryService, { strict: false });
      const found: unknown[] = [];
      for (const wrapper of discovery.getProviders()) {
        const instance: unknown = wrapper.instance;
        if (instance instanceof WorkerHost) found.push(instance);
      }
      return found;
    } catch {
      return [];
    }
  }

  /**
   * The app's `ProcessorDecoratorService` instance, but only if its `decorate`
   * is the function this package installed. A host that overrides the provider
   * with its own subclass shadows our patch, and reporting that as instrumented
   * would be the same lie this watcher is being fixed for.
   */
  private resolveSeamHost(ctx: WatcherContext): object | null {
    const { serviceClass, decorate } = this.instrumentation;
    if (!serviceClass || !decorate) return null;
    try {
      const found: unknown = ctx.moduleRef.get(serviceClass, { strict: false });
      if (typeof found !== 'object' || found === null) return null;
      return Reflect.get(found, 'decorate') === decorate ? found : null;
    } catch {
      return null;
    }
  }

  /** Fallback: re-point `worker.processFn`, which BullMQ reads per job. */
  private instrumentWorkers(processors: unknown[], runner: JobRunner): number {
    let count = 0;
    for (const processor of processors) {
      try {
        if (typeof processor !== 'object' || processor === null) continue;
        const worker: unknown = Reflect.get(processor, '_worker');
        if (!isWorkerLike(worker)) continue;
        if (isInstrumentedProcessor(worker.processFn)) continue;
        bindJobRunner(worker, runner);
        worker.processFn = instrumentProcessor(worker, worker.processFn);
        count++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`BullMqJobWatcher: failed to instrument a worker: ${message}`);
      }
    }
    return count;
  }

  /** One job: its own `queue` batch, its entry, and its throw re-thrown. */
  private runJob(
    ctx: WatcherContext,
    job: unknown,
    invoke: () => Promise<unknown>,
  ): Promise<unknown> {
    return ctx.runInBatch('queue', async () => {
      const startedAt = this.clock.now();
      try {
        const result = await invoke();
        // safeRecord never throws, so a telescope failure cannot turn a
        // successful job into a failed one.
        this.safeRecord(ctx, job, 'completed', this.clock.now() - startedAt, undefined);
        return result;
      } catch (error) {
        this.safeRecord(ctx, job, 'failed', this.clock.now() - startedAt, error);
        this.safeRecordException(ctx, job, error);
        throw error; // never swallow the host's error
      }
    });
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
