// packages/core/src/nest/telescope-overload-guard.service.ts
import * as perfHooks from 'node:perf_hooks';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

/** Default p99 event-loop lag (ms) that pauses capture when crossed. */
const DEFAULT_MAX_EVENT_LOOP_LAG_MS = 200;
/** How often the guard samples the lag histogram. */
const SAMPLE_INTERVAL_MS = 1_000;
const NS_PER_MS = 1e6;

/** A minimal monitor surface — only the bits the guard touches. */
interface EventLoopDelayMonitor {
  enable(): void;
  disable(): void;
  reset(): void;
  /** Delay at the given percentile, in nanoseconds. */
  percentile(percentile: number): number;
}

/** Structural guard: confirms a value exposes the monitor surface we read. */
function isEventLoopDelayMonitor(value: unknown): value is EventLoopDelayMonitor {
  if (typeof value !== 'object' || value === null) return false;
  if (!('enable' in value) || !('disable' in value)) return false;
  if (!('reset' in value) || !('percentile' in value)) return false;
  return (
    typeof value.enable === 'function' &&
    typeof value.disable === 'function' &&
    typeof value.reset === 'function' &&
    typeof value.percentile === 'function'
  );
}

/** Resolve the configured threshold, or `null` when overload protection is off. */
function resolveMaxLagMs(option: TelescopeModuleOptions['overloadProtection']): number | null {
  // Default ON at 200ms. `false` disables; an object tunes the threshold.
  if (option === false) return null;
  if (option === undefined || option === true) return DEFAULT_MAX_EVENT_LOOP_LAG_MS;
  return option.maxEventLoopLagMs ?? DEFAULT_MAX_EVENT_LOOP_LAG_MS;
}

/**
 * Overhead guard / overload protection. Samples the process event-loop delay
 * histogram (`perf_hooks.monitorEventLoopDelay`) on an interval and PAUSES the
 * Recorder when the p99 lag exceeds the configured threshold, resuming once it
 * recovers — so a telescope under load can never amplify an incident.
 *
 * Degrades to a no-op when `perf_hooks.monitorEventLoopDelay` is unavailable or
 * when `overloadProtection: false`. The sampling interval is unref'd so it never
 * keeps the host's event loop alive.
 */
@Injectable()
export class TelescopeOverloadGuard implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TelescopeOverloadGuard.name);
  private readonly maxLagMs: number | null;
  private monitor: EventLoopDelayMonitor | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TelescopeService) private readonly service: TelescopeService,
  ) {
    this.maxLagMs = resolveMaxLagMs(this.options.overloadProtection);
  }

  onModuleInit(): void {
    if (this.maxLagMs === null) return;
    this.monitor = startMonitor();
    if (this.monitor === null) return;
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.monitor?.disable();
    this.monitor = null;
  }

  /** Read the rolling p99 lag and pause/resume the Recorder around the threshold. */
  private sample(): void {
    const monitor = this.monitor;
    const maxLagMs = this.maxLagMs;
    if (monitor === null || maxLagMs === null) return;
    let p99Ms: number;
    try {
      p99Ms = monitor.percentile(99) / NS_PER_MS;
    } catch {
      return; // A misbehaving monitor must never crash the host.
    }
    // Reset the histogram each cycle so the decision reflects the RECENT window
    // (a per-process accumulation would never recover once lag spiked).
    monitor.reset();
    if (p99Ms >= maxLagMs) {
      if (!this.service.isPaused) {
        this.logger.warn(
          `Event-loop p99 lag ${p99Ms.toFixed(0)}ms >= ${maxLagMs}ms — pausing Telescope capture.`,
        );
        this.service.pause();
      }
    } else if (this.service.isPaused) {
      this.logger.log(
        `Event-loop p99 lag ${p99Ms.toFixed(0)}ms recovered — resuming Telescope capture.`,
      );
      this.service.resume();
    }
  }
}

/** Start an enabled event-loop-delay monitor, or `null` if perf_hooks lacks it. */
function startMonitor(): EventLoopDelayMonitor | null {
  const factory: unknown = perfHooks.monitorEventLoopDelay;
  if (typeof factory !== 'function') return null;
  try {
    const monitor: unknown = factory();
    if (!isEventLoopDelayMonitor(monitor)) return null;
    monitor.enable();
    return monitor;
  } catch {
    return null;
  }
}
