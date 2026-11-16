// packages/core/src/fleet/store.ts
//
// Where the fleet keeps its instances: in memory by default, or a store of your own.
import type { InstanceRecord } from './derive.js';

/** Where the fleet keeps its instances. */
export interface FleetStore {
  /** Insert or replace one instance (keyed by app + instance id). */
  upsert(record: InstanceRecord): Promise<void>;
  /** Instances seen since `since` (epoch ms), of `apps` (`null`: every app). */
  list(filter?: { apps?: readonly string[] | null; since?: number }): Promise<InstanceRecord[]>;
  /** Delete instances last seen before `before` (epoch ms). Returns how many. */
  prune(before: number): Promise<number>;
}

const key = (app: string, instanceId: string) => `${app}\u0000${instanceId}`;

/** Instances in this process (a standalone app, tests, or a control plane on the memory store). */
export class MemoryFleetStore implements FleetStore {
  private readonly rows = new Map<string, InstanceRecord>();

  constructor(private readonly maxInstances = 5000) {}

  async upsert(record: InstanceRecord): Promise<void> {
    const id = key(record.app, record.instanceId);
    this.rows.delete(id);
    this.rows.set(id, structuredClone(record));
    while (this.rows.size > this.maxInstances) {
      // Evict the least recently seen (insertion order = last upsert).
      this.rows.delete(this.rows.keys().next().value as string);
    }
  }

  async list(
    filter: { apps?: readonly string[] | null; since?: number } = {},
  ): Promise<InstanceRecord[]> {
    const apps = filter.apps ?? null;
    const since = filter.since ?? 0;
    return [...this.rows.values()]
      .filter((r) => (apps === null || apps.includes(r.app)) && r.lastSeenAt >= since)
      .map((r) => structuredClone(r));
  }

  async prune(before: number): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (row.lastSeenAt < before) {
        this.rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
