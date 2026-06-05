// integration/memory-soak/src/heap-retainers.ts
//
// Writes a V8 heap snapshot and computes the top object constructors by total
// self-size (shallow size summed per node `name`). This is a coarse but
// dependency-free retainer profile: the constructor whose aggregate size climbs
// across the soak names the leak's retained type.
//
// The .heapsnapshot format is documented JSON: { snapshot.meta.node_fields,
// node_types, nodes[], strings[] }. Each node is a flat run of `node_fields`
// integers; `name` indexes into `strings`, `self_size` is bytes.

import fs from 'node:fs';
import v8 from 'node:v8';

export interface RetainerRow {
  constructorName: string;
  totalSelfBytes: number;
  count: number;
}

interface RawSnapshot {
  snapshot: { meta: { node_fields: string[]; node_types: Array<string | string[]> } };
  nodes: number[];
  strings: string[];
}

/** Write a heap snapshot to `path` (caller chooses a stable location). */
export function writeSnapshot(path: string): void {
  v8.writeHeapSnapshot(path);
}

function isRawSnapshot(value: unknown): value is RawSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.strings) &&
    typeof candidate.snapshot === 'object'
  );
}

/**
 * Parse a snapshot file and return the top `limit` constructors by total self
 * size. Reads the whole file into memory — intended for offline analysis after
 * a run, never on the hot path.
 */
export function topRetainers(snapshotPath: string, limit = 25): RetainerRow[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  if (!isRawSnapshot(parsed)) {
    throw new Error('Unrecognized heap snapshot format');
  }
  const { nodes, strings } = parsed;
  const nodeFields = parsed.snapshot.meta.node_fields;
  const fieldCount = nodeFields.length;
  const nameOffset = nodeFields.indexOf('name');
  const selfSizeOffset = nodeFields.indexOf('self_size');
  if (nameOffset === -1 || selfSizeOffset === -1) {
    throw new Error('Heap snapshot missing name/self_size node fields');
  }

  const byName = new Map<string, RetainerRow>();
  for (let base = 0; base + fieldCount <= nodes.length; base += fieldCount) {
    const nameIndex = nodes[base + nameOffset];
    const selfSize = nodes[base + selfSizeOffset];
    if (nameIndex === undefined || selfSize === undefined) continue;
    const constructorName = strings[nameIndex] ?? '(unknown)';
    const existing = byName.get(constructorName);
    if (existing === undefined) {
      byName.set(constructorName, { constructorName, totalSelfBytes: selfSize, count: 1 });
    } else {
      existing.totalSelfBytes += selfSize;
      existing.count += 1;
    }
  }

  return [...byName.values()].sort((a, b) => b.totalSelfBytes - a.totalSelfBytes).slice(0, limit);
}

export function formatRetainers(rows: RetainerRow[]): string {
  const lines = rows.map((row) => {
    const mb = (row.totalSelfBytes / (1024 * 1024)).toFixed(2);
    return `  ${mb.padStart(8)} MB  x${String(row.count).padStart(8)}  ${row.constructorName}`;
  });
  return lines.join('\n');
}
