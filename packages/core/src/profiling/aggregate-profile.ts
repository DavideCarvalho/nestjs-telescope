// packages/core/src/profiling/aggregate-profile.ts
import type { FlameNode, HotFrame, V8CpuProfile, V8ProfileNode } from './types.js';

/** How many hottest-by-self frames to precompute for the dashboard. */
const HOT_FRAME_LIMIT = 12;

/** The synthetic root name V8 uses; we keep/normalize to it. */
const ROOT_NAME = '(root)';

interface Aggregated {
  tree: FlameNode;
  durationMs: number;
  sampleCount: number;
  hot: HotFrame[];
}

/**
 * Aggregates a raw V8 CPU profile into a flamegraph frame tree with self/total
 * time in milliseconds. Pure and deterministic — no inspector dependency, so it
 * is trivially unit-testable and runs OUTSIDE any hot path (only when a capture
 * actually completes).
 *
 * Method: each sample's `timeDelta` (microseconds) is charged to the SELF time
 * of the node it landed on. Total time is then the sum of a node's self time and
 * its descendants', computed by a single post-order walk. The flame tree mirrors
 * V8's `children` call-graph so callers nest exactly as they did at runtime.
 */
export function aggregateCpuProfile(profile: V8CpuProfile): Aggregated {
  const byId = new Map<number, V8ProfileNode>();
  for (const node of profile.nodes) byId.set(node.id, node);

  // 1. Charge each sample's time delta to its node's self time (microseconds).
  const selfMicros = new Map<number, number>();
  const selfSamples = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let totalMicros = 0;
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    if (id === undefined) continue;
    // V8 emits one delta per sample (the time elapsed before that sample). Fall
    // back to 0 if the arrays are mismatched rather than guessing.
    const delta = deltas[i] ?? 0;
    totalMicros += delta;
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + delta);
    selfSamples.set(id, (selfSamples.get(id) ?? 0) + 1);
  }

  // 2. Find (or synthesize) the root. V8 puts the (root) node first; tolerate
  // its absence by stitching all top-level nodes under a synthetic root.
  const rootNode = profile.nodes.find((n) => n.callFrame.functionName === ROOT_NAME);

  const build = (node: V8ProfileNode): FlameNode => {
    const childIds = node.children ?? [];
    const children: FlameNode[] = [];
    for (const childId of childIds) {
      const child = byId.get(childId);
      if (child) children.push(build(child));
    }
    const self = (selfMicros.get(node.id) ?? 0) / 1000;
    const selfCount = selfSamples.get(node.id) ?? 0;
    const childTotal = children.reduce((sum, c) => sum + c.totalMs, 0);
    const childSamples = children.reduce((sum, c) => sum + c.totalSamples, 0);
    return {
      name: normalizeName(node.callFrame.functionName),
      file: frameFile(node),
      selfMs: self,
      totalMs: self + childTotal,
      totalSamples: selfCount + childSamples,
      children,
    };
  };

  let tree: FlameNode;
  if (rootNode) {
    tree = build(rootNode);
  } else {
    // No explicit root: every node referenced as a child belongs to a parent;
    // top-level nodes are those never referenced. Stitch them under a synthetic root.
    const referenced = new Set<number>();
    for (const node of profile.nodes) {
      for (const childId of node.children ?? []) referenced.add(childId);
    }
    const tops = profile.nodes.filter((n) => !referenced.has(n.id)).map(build);
    const childTotal = tops.reduce((sum, c) => sum + c.totalMs, 0);
    tree = {
      name: ROOT_NAME,
      file: '',
      selfMs: 0,
      totalMs: childTotal,
      totalSamples: tops.reduce((sum, c) => sum + c.totalSamples, 0),
      children: tops,
    };
  }

  // 3. Hot frames by self time (flatten, sort desc, take N).
  const totalMs = totalMicros / 1000;
  const flat: HotFrame[] = [];
  const visit = (node: FlameNode): void => {
    if (node.selfMs > 0) {
      flat.push({
        name: node.name,
        file: node.file,
        selfMs: node.selfMs,
        selfPct: totalMs > 0 ? (node.selfMs / totalMs) * 100 : 0,
      });
    }
    for (const child of node.children) visit(child);
  };
  visit(tree);
  flat.sort((a, b) => b.selfMs - a.selfMs);

  return {
    tree,
    durationMs: durationFor(profile, totalMicros),
    sampleCount: samples.length,
    hot: flat.slice(0, HOT_FRAME_LIMIT),
  };
}

/** Prefer the summed sample deltas; fall back to start/end when samples absent. */
function durationFor(profile: V8CpuProfile, totalMicros: number): number {
  if (totalMicros > 0) return totalMicros / 1000;
  const wall = profile.endTime - profile.startTime;
  return wall > 0 ? wall / 1000 : 0;
}

function normalizeName(name: string): string {
  return name === '' ? '(anonymous)' : name;
}

function frameFile(node: V8ProfileNode): string {
  const { url, lineNumber } = node.callFrame;
  if (url === '') return '';
  return lineNumber >= 0 ? `${url}:${lineNumber + 1}` : url;
}
