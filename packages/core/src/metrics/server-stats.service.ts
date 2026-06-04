// packages/core/src/metrics/server-stats.service.ts
import * as perfHooks from 'node:perf_hooks';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
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

  constructor(@Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig) {
    this.loopMonitor = startEventLoopMonitor();
  }

  onApplicationShutdown(): void {
    this.loopMonitor?.disable();
  }

  getStats(): ServerStats {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const eventLoopDelayMs =
      this.loopMonitor === null ? null : roundMs(this.loopMonitor.mean / NS_PER_MS);
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
