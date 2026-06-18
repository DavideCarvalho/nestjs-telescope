// packages/core/src/profiling/profiler.service.ts
import { EntryType, type RecordInput } from '../entry/entry.js';
import { CpuProfiler, type CpuProfilerResult } from './cpu-profiler.js';
import type { ResolvedProfilingConfig } from './profiling-config.js';
import type { CpuProfileContent } from './types.js';

/** The `type` of the entries this service records. */
export const CPU_PROFILE_ENTRY_TYPE = EntryType.CpuProfile;

/** Opaque handle for an in-flight capture, returned by {@link ProfilerService.begin}. */
export interface ProfileHandle {
  readonly profiler: ProfilerLike;
  readonly startedAt: number;
  readonly reason: 'manual' | 'sampled';
  /**
   * The (fire-and-forget) start promise. {@link ProfilerService.end} awaits it
   * before calling `stop()` so a capture that ends before `start()` settled (a
   * very fast request, or a synchronous test) is still stopped correctly rather
   * than seeing `isRunning === false` and silently dropping the profile.
   */
  readonly started: Promise<void>;
}

/** Minimal profiler contract so the service can be tested with a fake. */
export interface ProfilerLike {
  readonly isRunning: boolean;
  start(): Promise<void>;
  stop(): Promise<CpuProfilerResult | null>;
}

/** A pending manual capture budget: profile up to `count` more requests. */
interface ManualArm {
  count: number;
  /** When set, only requests whose label === this consume the budget. */
  label?: string;
}

export interface ProfilerServiceDeps {
  /** Records the finished profile as a `cpu_profile` entry (via the Recorder). */
  record: (input: RecordInput<CpuProfileContent>) => void;
  /** RNG for sampling — injectable for deterministic tests. */
  random?: () => number;
  /** Builds a profiler; injectable so tests avoid the real inspector. */
  profilerFactory?: () => ProfilerLike;
}

export interface ProfilerStatus {
  enabled: boolean;
  sampleRate: number;
  /** Currently in-flight captures. */
  active: number;
  maxConcurrent: number;
  /** Remaining manual budget across all arms. */
  pendingManual: number;
}

/**
 * Decides whether to profile a request and drives the capture lifecycle around
 * it. The integration calls {@link shouldProfile} (cheap gate), then
 * {@link begin}/{@link end} around the request body.
 *
 * OVERHEAD: while disabled, {@link shouldProfile} returns false and {@link begin}
 * returns null after a single boolean check — no profiler is ever constructed
 * and `node:inspector` is never required. While enabled but a request isn't
 * selected, the only added cost is the gate and (if sampling) one RNG call.
 */
export class ProfilerService {
  private active = 0;
  private readonly manual: ManualArm[] = [];
  private readonly random: () => number;
  private readonly profilerFactory: () => ProfilerLike;

  constructor(
    private readonly config: ResolvedProfilingConfig,
    private readonly deps: ProfilerServiceDeps,
  ) {
    this.random = deps.random ?? Math.random;
    this.profilerFactory =
      deps.profilerFactory ??
      (() => new CpuProfiler(undefined, { samplingIntervalMicros: config.samplingIntervalMicros }));
  }

  /**
   * Arm a manual capture for the next `count` requests (optionally only those
   * matching `label`). Returns the pending budget. No-op when disabled.
   */
  arm(arm: ManualArm): { pendingManual: number } {
    if (!this.config.enabled) return { pendingManual: 0 };
    const count = Math.max(1, Math.floor(arm.count));
    this.manual.push({ count, ...(arm.label ? { label: arm.label } : {}) });
    return { pendingManual: this.pendingManual() };
  }

  /**
   * Whether this request should be profiled. Consults the manual arm budget
   * first (targeted captures win), then sampling. Cheap and side-effect-free
   * EXCEPT it does not yet consume the manual budget — that happens in
   * {@link begin} so a request rejected by the concurrency cap doesn't waste it.
   */
  shouldProfile(label: string | null): boolean {
    if (!this.config.enabled) return false;
    if (this.matchingArm(label) !== null) return true;
    if (this.config.sampleRate <= 0) return false;
    return this.random() < this.config.sampleRate;
  }

  /**
   * Begin a capture for a request that {@link shouldProfile} accepted. Returns a
   * handle to pass to {@link end}, or `null` if the request should not be
   * profiled (disabled, concurrency cap reached, or not selected). The caller
   * MUST treat a null handle as "no profiling" and proceed untouched.
   */
  begin(label: string | null): ProfileHandle | null {
    if (!this.config.enabled) return null;
    const arm = this.matchingArm(label);
    const reason: 'manual' | 'sampled' = arm !== null ? 'manual' : 'sampled';
    if (reason === 'sampled') {
      if (this.config.sampleRate <= 0 || this.random() >= this.config.sampleRate) return null;
    }
    // Respect the concurrency cap BEFORE consuming the manual budget so a capped
    // request can be retried by a later arm.
    if (this.active >= this.config.maxConcurrent) return null;
    if (arm !== null) {
      arm.count -= 1;
      if (arm.count <= 0) this.manual.splice(this.manual.indexOf(arm), 1);
    }
    const profiler = this.profilerFactory();
    this.active += 1;
    // Start asynchronously; the handle is valid immediately. A start failure
    // simply yields an empty/partial profile at stop — never throws into the host.
    // The promise is retained on the handle so `end` can await it before stopping.
    const started = profiler.start().catch(() => {});
    return { profiler, startedAt: now(), reason, started };
  }

  /**
   * Stop a capture and record it as a `cpu_profile` entry. Safe to call with a
   * null handle (no-op). Never throws into the host request path. Captures below
   * the `minDurationMs` floor are discarded.
   */
  async end(handle: ProfileHandle | null, label: string | null): Promise<void> {
    if (handle === null) return;
    try {
      // Ensure `start()` settled so `stop()` sees a running profiler. (Real
      // requests run long enough that start is done; this guards the fast path.)
      await handle.started;
      const result = await handle.profiler.stop();
      if (result === null) return;
      if (result.durationMs < this.config.minDurationMs) return;
      const content: CpuProfileContent = {
        durationMs: result.durationMs,
        sampleCount: result.sampleCount,
        reason: handle.reason,
        label: label ?? null,
        tree: result.tree,
        hot: result.hot,
      };
      this.deps.record({
        type: CPU_PROFILE_ENTRY_TYPE,
        content,
        familyHash: label ?? null,
        tags: ['profile', handle.reason],
        durationMs: result.durationMs,
      });
    } catch {
      // A failed capture must never affect the request it wrapped.
    } finally {
      this.active = Math.max(0, this.active - 1);
    }
  }

  status(): ProfilerStatus {
    return {
      enabled: this.config.enabled,
      sampleRate: this.config.sampleRate,
      active: this.active,
      maxConcurrent: this.config.maxConcurrent,
      pendingManual: this.pendingManual(),
    };
  }

  private pendingManual(): number {
    return this.manual.reduce((sum, a) => sum + a.count, 0);
  }

  /** First arm matching this label (labelled arms require an exact match). */
  private matchingArm(label: string | null): ManualArm | null {
    for (const arm of this.manual) {
      if (arm.count <= 0) continue;
      if (arm.label === undefined) return arm;
      if (label !== null && arm.label === label) return arm;
    }
    return null;
  }
}

function now(): number {
  return Date.now();
}
