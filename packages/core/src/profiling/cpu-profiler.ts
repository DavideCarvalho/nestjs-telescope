// packages/core/src/profiling/cpu-profiler.ts
import { createRequire } from 'node:module';
import { aggregateCpuProfile } from './aggregate-profile.js';
import type { FlameNode, HotFrame, V8CpuProfile } from './types.js';

/**
 * The slice of `inspector.Session` we depend on. Declared structurally so the
 * profiler can be unit-tested with a fake and — crucially — so the real
 * `node:inspector` module is NEVER imported at module load. It is required
 * lazily by {@link defaultSessionFactory} ONLY when a capture actually starts.
 */
export interface InspectorSessionLike {
  connect(): void;
  disconnect(): void;
  post(
    method: string,
    paramsOrCallback?: unknown | ((err: Error | null, result?: unknown) => void),
    callback?: (err: Error | null, result?: unknown) => void,
  ): void;
}

export type SessionFactory = () => InspectorSessionLike;

export interface CpuProfilerOptions {
  /**
   * V8 sampling interval in microseconds. Lower = finer-grained but more
   * overhead. V8's default is 1000µs (1ms); we keep that default.
   */
  samplingIntervalMicros?: number;
}

export interface CpuProfilerResult {
  tree: FlameNode;
  durationMs: number;
  sampleCount: number;
  hot: HotFrame[];
}

const DEFAULT_SAMPLING_INTERVAL_MICROS = 1000;

/**
 * Wraps a V8 CPU profiling session over the inspector protocol. A single
 * profiler instance captures ONE profile at a time (`start` then `stop`).
 *
 * OVERHEAD GUARANTEE: constructing a profiler does no work and creates no
 * session. The inspector session is created (and `node:inspector` is required)
 * only inside `start()`. When profiling is disabled the controller never
 * constructs one, so there is provably zero inspector activity.
 */
export class CpuProfiler {
  private session: InspectorSessionLike | null = null;
  private running = false;
  private readonly intervalMicros: number;

  constructor(
    private readonly sessionFactory: SessionFactory = defaultSessionFactory,
    options: CpuProfilerOptions = {},
  ) {
    this.intervalMicros = options.samplingIntervalMicros ?? DEFAULT_SAMPLING_INTERVAL_MICROS;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Begin a CPU profile. No-op if one is already running. */
  async start(): Promise<void> {
    if (this.running) return;
    const session = this.sessionFactory();
    session.connect();
    this.session = session;
    await this.postAsync(session, 'Profiler.enable');
    await this.postAsync(session, 'Profiler.setSamplingInterval', {
      interval: this.intervalMicros,
    });
    await this.postAsync(session, 'Profiler.start');
    this.running = true;
  }

  /**
   * Stop the profile and aggregate it into a flame tree. Returns `null` when no
   * profile is running. Always disconnects the session, even on error.
   */
  async stop(): Promise<CpuProfilerResult | null> {
    const session = this.session;
    if (!this.running || session === null) return null;
    try {
      const result = (await this.postAsync(session, 'Profiler.stop')) as {
        profile: V8CpuProfile;
      };
      return aggregateCpuProfile(result.profile);
    } finally {
      this.running = false;
      this.session = null;
      try {
        session.disconnect();
      } catch {
        // A disconnect failure must never mask the captured profile or throw.
      }
    }
  }

  private postAsync(
    session: InspectorSessionLike,
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null, result?: unknown): void => {
        if (err) reject(err);
        else resolve(result);
      };
      if (params === undefined) session.post(method, cb);
      else session.post(method, params, cb);
    });
  }
}

/**
 * Lazily require `node:inspector` and return a fresh Session. Kept out of the
 * module's import graph so that importing this file (or the whole package) does
 * NOT load the inspector binding — that only happens the first time a capture
 * starts, i.e. only when profiling is enabled AND a request is sampled.
 */
export function defaultSessionFactory(): InspectorSessionLike {
  // `createRequire` performs a SYNCHRONOUS require of the built-in without it
  // appearing in this module's static import graph, so loading the package never
  // pulls in the inspector binding. Built only on first capture.
  const requireFn = createRequire(import.meta.url);
  const inspector = requireFn('node:inspector') as {
    Session: new () => InspectorSessionLike;
  };
  return new inspector.Session();
}
