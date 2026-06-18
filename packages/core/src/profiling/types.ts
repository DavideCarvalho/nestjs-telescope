// packages/core/src/profiling/types.ts

/**
 * The raw V8 CPU profile shape produced by `Profiler.stop` over the inspector
 * protocol. We model only the fields we consume so we never depend on the
 * inspector typings at our public surface (the `inspector` module is required
 * lazily and ONLY when profiling is enabled — see {@link CpuProfiler}).
 *
 * @see https://chromedevtools.github.io/devtools-protocol/tot/Profiler/#type-Profile
 */
export interface V8CpuProfile {
  /** Flat list of unique call-frame nodes. */
  nodes: V8ProfileNode[];
  /** Profile start time in microseconds. */
  startTime: number;
  /** Profile end time in microseconds. */
  endTime: number;
  /** Node ids sampled, one per sample, in time order. */
  samples?: number[];
  /** Time deltas (microseconds) between consecutive samples. */
  timeDeltas?: number[];
}

export interface V8ProfileNode {
  id: number;
  callFrame: V8CallFrame;
  /** Number of samples where this exact node was on top of the stack. */
  hitCount?: number;
  /** Child node ids (callees). */
  children?: number[];
}

export interface V8CallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

/**
 * An aggregated flamegraph node. Time is in MILLISECONDS. `selfMs` is time spent
 * in this frame with nothing above it; `totalMs` includes all descendants. The
 * tree is rooted at a synthetic `(root)` frame so the dashboard can render a
 * single top bar spanning the whole capture.
 */
export interface FlameNode {
  /** Human-readable function name (`(anonymous)` / `(idle)` etc. preserved). */
  name: string;
  /** Source location `url:line`, or empty when V8 reported none (native/builtin). */
  file: string;
  /** Inclusive time across this frame and all descendants, in ms. */
  totalMs: number;
  /** Exclusive time in this frame only (samples landing directly here), in ms. */
  selfMs: number;
  /** Sample count attributed inclusively to this subtree. */
  totalSamples: number;
  children: FlameNode[];
}

/**
 * The persisted content of a `cpu_profile` entry. Deliberately stores the
 * AGGREGATED frame tree (bounded by the call-graph size) rather than the raw
 * per-sample `.cpuprofile` (which is unbounded and would blow the entry content
 * budget). The frame tree is everything the flamegraph renderer needs.
 */
export interface CpuProfileContent {
  /** Wall-clock capture duration in ms (endTime - startTime). */
  durationMs: number;
  /** Number of samples collected. */
  sampleCount: number;
  /** What triggered the capture. */
  reason: 'manual' | 'sampled';
  /** Route / label the profile is associated with, when known (e.g. "GET /users/:id"). */
  label: string | null;
  /** The aggregated flamegraph tree (single synthetic root). */
  tree: FlameNode;
  /**
   * Hottest frames by SELF time, precomputed for the dashboard's "hot functions"
   * list so the UI doesn't have to walk the tree. Capped to a small number.
   */
  hot: HotFrame[];
}

export interface HotFrame {
  name: string;
  file: string;
  selfMs: number;
  /** Percentage of total captured time spent self in this frame (0–100). */
  selfPct: number;
}
