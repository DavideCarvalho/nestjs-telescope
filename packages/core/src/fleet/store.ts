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
  /** Per app, its instance keys, least recently seen first. */
  private readonly byApp = new Map<string, Set<string>>();

  /**
   * `maxPerApp` bounds each app on its own: a tenant that rotates instance ids (a bug, or a
   * hostile sender) only evicts its own rows, never another app's. `maxInstances` bounds the total.
   */
  constructor(
    private readonly maxInstances = 5000,
    private readonly maxPerApp = 500,
  ) {}

  async upsert(record: InstanceRecord): Promise<void> {
    const id = key(record.app, record.instanceId);
    this.rows.delete(id);
    this.rows.set(id, structuredClone(record));
    let own = this.byApp.get(record.app);
    if (own === undefined) {
      own = new Set();
      this.byApp.set(record.app, own);
    }
    own.delete(id);
    own.add(id);
    while (own.size > this.maxPerApp) this.remove(own.values().next().value as string);
    while (this.rows.size > this.maxInstances) {
      // Past the total, evict from the app with the most instances (its least recently seen).
      let largest: Set<string> | undefined;
      for (const keys of this.byApp.values())
        if (!largest || keys.size > largest.size) largest = keys;
      const oldest = largest?.values().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  private remove(id: string): void {
    const row = this.rows.get(id);
    this.rows.delete(id);
    if (row === undefined) return;
    const own = this.byApp.get(row.app);
    own?.delete(id);
    if (own?.size === 0) this.byApp.delete(row.app);
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
        this.remove(id);
        removed += 1;
      }
    }
    return removed;
  }
}
