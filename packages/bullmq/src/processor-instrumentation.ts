// packages/bullmq/src/processor-instrumentation.ts
import { createRequire } from 'node:module';
// Namespace import ON PURPOSE: `ProcessorDecoratorService` only exists from
// @nestjs/bullmq v11. A named import of a missing CJS export is a hard
// SyntaxError at link time, which would make this package unloadable on v10
// instead of degrading to the fallback below.
import * as bullmq from '@nestjs/bullmq';

/**
 * The seam that makes BullMQ jobs observable, and WHY it is this seam.
 *
 * `BullExplorer.handleProcessor` (bull.explorer.js) binds a static processor
 * ONCE, at `BullRegistrar.onModuleInit`:
 *
 *     processor = instance['process'].bind(instance);
 *     processor = this.processorDecoratorService.decorate(processor);
 *     new Worker(queueName, processor, …)
 *
 * That bound reference is what the worker calls for every job, forever. So any
 * instrumentation applied to the processor's PROTOTYPE after that moment — and
 * Telescope registers watchers at `onApplicationBootstrap`, always after — is
 * dead code: the worker never looks at the prototype again. This watcher did
 * exactly that, and the measured result on a real Redis was zero entries per
 * job: no `job` entry, no exception, no batch at all.
 *
 * `ProcessorDecoratorService.decorate` is the framework's own extension point
 * for wrapping a processor ("This method can be overridden to provide custom
 * behavior for processor decoration") and it sits on BOTH branches:
 * the static one above, and the request-scoped one, where it is applied per job
 * to the freshly resolved per-context instance. Patching its prototype in the
 * watcher's CONSTRUCTOR — which runs while the host is still building its module
 * metadata, before `NestFactory.create` and therefore before every explorer —
 * means the function BullMQ hands to `new Worker(...)` is already ours.
 *
 * The runner is bound LATE: the seam looks up the active runner on each call, so
 * a processor decorated at `onModuleInit` picks up the `WatcherContext` that
 * only exists at `onApplicationBootstrap`. Before it is bound (or after the app
 * closes) the seam calls straight through, so a job is never blocked on
 * Telescope being ready.
 *
 * State lives on the `ProcessorDecoratorService` INSTANCE, not in a module-level
 * variable: the prototype is process-global (two Nest apps in one test file
 * share it), but each app has its own provider instance, so each app's jobs
 * reach only its own Telescope.
 */

/** Run one job: `invoke()` is the real processor call, already bound. */
export type JobRunner = (job: unknown, invoke: () => Promise<unknown>) => Promise<unknown>;

/** BullMQ's processor signature, loosened to what we forward blindly. */
type JobProcessor = (...args: unknown[]) => unknown;

/** The one method of `ProcessorDecoratorService` we rely on. */
interface DecorateHost {
  decorate(processor: JobProcessor): JobProcessor;
}

interface DecorateHostClass {
  new (...args: never[]): DecorateHost;
  prototype: DecorateHost;
}

/** Per-host (= per Nest app) instrumentation state. */
interface HostState {
  /** Set by the watcher at register(); null means "call straight through". */
  runner: JobRunner | null;
  /** Processors wrapped so far — the ordering proof read by register(). */
  wraps: number;
}

/** The outcome of patching the seam, reported at boot when it failed. */
export interface ProcessorInstrumentation {
  readonly installed: boolean;
  /** Human-readable reason the seam is unavailable, for the boot warning. */
  readonly reason: string | null;
  /** The class to resolve from the host's DI container, when installed. */
  readonly serviceClass: DecorateHostClass | null;
  /** Our patched `decorate`, so register() can prove the app resolved OURS. */
  readonly decorate: ((processor: JobProcessor) => JobProcessor) | null;
}

const STATE = Symbol.for('@dudousxd/nestjs-telescope:bullmq-processor-state');
const INSTRUMENTED = Symbol.for('@dudousxd/nestjs-telescope:bullmq-instrumented');

let outcome: ProcessorInstrumentation | null = null;

function isDecorateHost(value: unknown): value is DecorateHost {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'decorate') === 'function';
}

function isDecorateHostClass(value: unknown): value is DecorateHostClass {
  if (typeof value !== 'function') return false;
  return isDecorateHost(Reflect.get(value, 'prototype'));
}

function isHostState(value: unknown): value is HostState {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'wraps') === 'number' && 'runner' in value;
}

/** The state bag for one host object, created on first use. Non-enumerable so
 *  it never shows up in a host's own serialisation of the provider. */
function stateOf(host: object): HostState {
  const existing: unknown = Reflect.get(host, STATE);
  if (isHostState(existing)) return existing;
  const created: HostState = { runner: null, wraps: 0 };
  Object.defineProperty(host, STATE, { value: created, configurable: true, writable: true });
  return created;
}

/** The installed `@nestjs/bullmq` version, for the "not instrumented" warning.
 *  A failure to read it must not be louder than the thing it is annotating. */
function bullmqVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg: unknown = require('@nestjs/bullmq/package.json');
    if (typeof pkg === 'object' && pkg !== null) {
      const version: unknown = Reflect.get(pkg, 'version');
      if (typeof version === 'string') return version;
    }
    return 'unknown version';
  } catch {
    return 'unknown version';
  }
}

/**
 * Wrap one processor function so every call runs through the active runner.
 * Exported because the fallback path (below, for a framework version without
 * the decorator seam) wraps `worker.processFn` with the very same wrapper.
 */
export function instrumentProcessor(host: object, processor: JobProcessor): JobProcessor {
  stateOf(host).wraps++;
  const instrumented = function telescopeProcessor(this: unknown, ...args: unknown[]): unknown {
    const runner = stateOf(host).runner;
    if (!runner) return processor.apply(this, args);
    // The arrow keeps `this`, so the processor is called on exactly the
    // receiver BullMQ used — the per-context instance on the scoped branch.
    return runner(args[0], async () => processor.apply(this, args));
  };
  Object.defineProperty(instrumented, INSTRUMENTED, { value: true, configurable: true });
  return instrumented;
}

/** Is this the function Telescope handed the worker? Used by the tests that
 *  assert the framework captured OUR reference and not the raw handler. */
export function isInstrumentedProcessor(value: unknown): boolean {
  if (typeof value !== 'function') return false;
  return Reflect.get(value, INSTRUMENTED) === true;
}

/** Patch `ProcessorDecoratorService.prototype.decorate`, once per process. */
export function installProcessorInstrumentation(): ProcessorInstrumentation {
  if (outcome) return outcome;
  outcome = install();
  return outcome;
}

function install(): ProcessorInstrumentation {
  const serviceClass: unknown = bullmq.ProcessorDecoratorService;
  if (!isDecorateHostClass(serviceClass)) {
    return {
      installed: false,
      reason: `@nestjs/bullmq ${bullmqVersion()} exposes no ProcessorDecoratorService.decorate seam`,
      serviceClass: null,
      decorate: null,
    };
  }
  const prototype = serviceClass.prototype;
  const original = prototype.decorate;

  function decorate(this: DecorateHost, processor: JobProcessor): JobProcessor {
    // Call through first: whatever the framework (or a future version) does to
    // the processor happens exactly as it would without Telescope.
    const inner = original.call(this, processor);
    // Keyed on the service INSTANCE, so each Nest app records into its own.
    return instrumentProcessor(this, inner);
  }

  prototype.decorate = decorate;
  return { installed: true, reason: null, serviceClass, decorate };
}

/**
 * Point a host's seam at `runner` and report how many processors it had already
 * wrapped. A non-zero count is the proof of ordering: those wraps happened at
 * the explorer's `onModuleInit`, strictly before this call at
 * `onApplicationBootstrap`. Zero is normal only for request-scoped processors,
 * which the framework decorates per job.
 */
export function bindJobRunner(host: object, runner: JobRunner): number {
  const state = stateOf(host);
  state.runner = runner;
  return state.wraps;
}

/** Detach the runner (the app is going away); the seam calls straight through. */
export function unbindJobRunner(host: object): void {
  stateOf(host).runner = null;
}
