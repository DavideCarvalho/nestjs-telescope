// packages/core/src/metrics/server-stats.service.ts
import * as perfHooks from 'node:perf_hooks';
import { Inject, Injectable, type OnApplicationShutdown, Optional } from '@nestjs/common';
import type { ResolvedCoreConfig } from '../config/options.js';
import { TELESCOPE_CONFIG } from '../nest/telescope.options.js';

export interface ServerStats {
  uptimeSec: number;
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  cpu: { userMs: number; systemMs: number };
  /** Mean event-loop delay in ms, or `null` when perf_hooks can't measure it. */
  eventLoopDelayMs: number | null;
  instanceId: string;
}

/** One point in the CPU/mem history ring buffer. */
export interface ServerStatsSample {
  /** Wall-clock time of the sample (epoch ms). */
  atMs: number;
  rssMb: number;
  heapUsedMb: number;
  /** CPU utilisation since the previous sample, as a percent of one core (>= 0;
   *  0 on the very first sample, where there is no previous interval). */
  cpuPercent: number;
  /** Mean event-loop delay (ms) at sample time, or null when unavailable. */
  eventLoopDelayMs: number | null;
}

export interface ServerStatsHistory {
  samples: ServerStatsSample[];
}

export interface ServerStatsServiceOptions {
  /** Ring-buffer cap for the CPU/mem history. Default 120 (~10m at a 5s poll). */
  maxSamples?: number;
}

const DEFAULT_MAX_SAMPLES = 120;

/** A minimal monitor surface — only the bits the service touches. */
interface EventLoopDelayMonitor {
  enable(): void;
  disable(): void;
  /** Mean delay in nanoseconds. */
  mean: number;
}

const BYTES_PER_MB = 1024 * 1024;
const NS_PER_MS = 1e6;
const US_PER_MS = 1e3;

function toMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 100) / 100;
}

/**
 * Point-in-time snapshot of the Node process health (memory, CPU, uptime,
 * event-loop delay). The event-loop histogram is started once at construction
 * and read per request so its mean reflects the whole process lifetime. When
 * `perf_hooks.monitorEventLoopDelay` is unavailable, the delay degrades to
 * `null` rather than throwing — every other field is always present.
 */
@Injectable()
export class ServerStatsService implements OnApplicationShutdown {
  private readonly loopMonitor: EventLoopDelayMonitor | null;
  private readonly maxSamples: number;
  /** CPU/mem history ring buffer (oldest first). */
  private readonly samples: ServerStatsSample[] = [];
  /** Previous (cpuUsage, wall ms) for deriving the per-interval cpuPercent. */
  private lastCpu: NodeJS.CpuUsage | null = null;
  private lastSampleMs = 0;

  constructor(
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
    @Optional() options?: ServerStatsServiceOptions,
  ) {
    this.loopMonitor = startEventLoopMonitor();
    this.maxSamples = Math.max(1, Math.floor(options?.maxSamples ?? DEFAULT_MAX_SAMPLES));
  }

  onApplicationShutdown(): void {
    this.loopMonitor?.disable();
  }

  getStats(): ServerStats {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const eventLoopDelayMs =
      this.loopMonitor === null ? null : roundMs(this.loopMonitor.mean / NS_PER_MS);
    this.recordSample(memory, cpu, eventLoopDelayMs);
    return {
      uptimeSec: Math.round(process.uptime() * 100) / 100,
      memory: {
        rssMb: toMb(memory.rss),
        heapUsedMb: toMb(memory.heapUsed),
        heapTotalMb: toMb(memory.heapTotal),
      },
      cpu: {
        userMs: roundMs(cpu.user / US_PER_MS),
        systemMs: roundMs(cpu.system / US_PER_MS),
      },
      eventLoopDelayMs,
      instanceId: this.config.instanceId,
    };
  }

  /** The CPU/mem history captured so far (oldest first), for the dashboard's
   *  CPU/mem-history card. Cheap copy of the ring buffer. */
  getHistory(): ServerStatsHistory {
    return { samples: [...this.samples] };
  }

  /**
   * Append one history sample, deriving cpuPercent from the CPU-time delta since
   * the previous sample over the wall-clock interval (percent of ONE core). The
   * first sample has no prior interval, so its cpuPercent is 0. Evicts the oldest
   * once the ring buffer exceeds its cap.
   */
  private recordSample(
    memory: NodeJS.MemoryUsage,
    cpu: NodeJS.CpuUsage,
    eventLoopDelayMs: number | null,
  ): void {
    const nowMs = Date.now();
    let cpuPercent = 0;
    if (this.lastCpu !== null && this.lastSampleMs > 0) {
      const cpuDeltaUs = cpu.user - this.lastCpu.user + (cpu.system - this.lastCpu.system);
      const wallDeltaMs = nowMs - this.lastSampleMs;
      if (wallDeltaMs > 0) {
        // cpuDeltaUs is microseconds of CPU; wallDeltaMs*1000 is the interval in
        // microseconds. The ratio is the fraction of one core, ×100 for percent.
        cpuPercent = Math.max(
          0,
          Math.round((cpuDeltaUs / (wallDeltaMs * US_PER_MS)) * 10000) / 100,
        );
      }
    }
    this.lastCpu = cpu;
    this.lastSampleMs = nowMs;
    this.samples.push({
      atMs: nowMs,
      rssMb: toMb(memory.rss),
      heapUsedMb: toMb(memory.heapUsed),
      cpuPercent,
      eventLoopDelayMs,
    });
    while (this.samples.length > this.maxSamples) this.samples.shift();
  }
}

function roundMs(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

/** Start an enabled event-loop-delay monitor, or `null` if perf_hooks lacks it. */
function startEventLoopMonitor(): EventLoopDelayMonitor | null {
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

/** Structural guard: confirms a value exposes the monitor surface we read. */
function isEventLoopDelayMonitor(value: unknown): value is EventLoopDelayMonitor {
  if (typeof value !== 'object' || value === null) return false;
  if (!('enable' in value) || !('disable' in value) || !('mean' in value)) return false;
  return (
    typeof value.enable === 'function' &&
    typeof value.disable === 'function' &&
    typeof value.mean === 'number'
  );
}
