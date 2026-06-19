// packages/core/src/extension/types.ts
import type { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import type { Entry, RecordInput } from '../entry/entry.js';
import type { Watcher } from '../nest/watcher.js';

/**
 * The published, versioned extension contract for `@dudousxd/nestjs-telescope`.
 *
 * Extensions are objects (usually returned by a factory so they can take options)
 * registered via `TelescopeModule.forRoot({ extensions: [...] })`. The host runs
 * their hooks at module init. Hooks are **multi** (every extension runs; results
 * accumulate). Single-slot hooks are intentionally not part of 0.x — the registry
 * is shaped to add them when a consumer needs one.
 *
 * @remarks Semver 0.x — the shape may change until 1.0. Out-of-repo extensions
 * should pin a compatible `@dudousxd/nestjs-telescope` peer range.
 */
export interface TelescopeExtension {
  /** Unique id — used in conflict/collision errors and for deterministic ordering. */
  name: string;
  /** Contribute watchers. Merged into the existing `forRoot.watchers` list. */
  watchers?(ctx: ExtensionContext): Watcher[];
  /** Contribute navigable entry types — makes the hard-coded UI ENTRY_TYPES dynamic. */
  entryTypes?(ctx: ExtensionContext): ExtensionEntryType[];
  /** Contribute declarative dashboard pages (the panel IR). */
  dashboards?(ctx: ExtensionContext): DashboardSpec[];
  /** Named server-side queries that panels bind to via `{ provider, query }`. */
  dataProviders?(ctx: ExtensionContext): DataProvider[];
  /**
   * Observe EVERY recorded input (pre-sampling, complete counts) — drives metrics
   * export. Fired synchronously on the hot path; keep it cheap. Isolated by the
   * host: a throw is swallowed and never affects capture.
   */
  observeRecord?(input: RecordInput): void;
  /**
   * Observe each just-persisted (post-sampling) batch — drives span/trace export.
   * Awaited off the host path inside the flush chain; a throw/rejection is
   * swallowed and never breaks the flush.
   */
  observeFlush?(entries: Entry[]): void | Promise<void>;
}

/** Read-only context handed to every extension hook, resolved at module init. */
export interface ExtensionContext {
  /** Resolve host services (e.g. a durable engine/store, or TELESCOPE_STORAGE). */
  readonly moduleRef: ModuleRef;
  readonly config: ResolvedCoreConfig;
}

/** A navigable entry type contributed by an extension (subset of the UI's EntryTypeDef). */
export interface ExtensionEntryType {
  /** Backend `type` filter value, e.g. 'durable'. */
  id: string;
  /** Nav label, e.g. 'Workflows'. */
  label: string;
  /** Tailwind `bg-*` dot color for the nav, e.g. 'bg-amber-400'. */
  dot: string;
}

/** Threshold coloring for a numeric panel. `direction` says which way is worse. */
export interface PanelThresholds {
  warn: number;
  bad: number;
  direction: 'up-bad' | 'down-bad';
}

/** A group of panels rendered together with its own column count. */
export interface DashboardSection {
  title?: string;
  cols?: 2 | 3 | 4;
  panels: Panel[];
}

/** A declarative dashboard page. */
export interface DashboardSpec {
  /** Stable route id, e.g. 'durable.workflows'. Globally unique across extensions. */
  id: string;
  /** Nav label, e.g. 'Workflows'. */
  label: string;
  /** Optional nav grouping header. */
  navGroup?: string;
  /** Flat layout (back-compat). Prefer `sections` for hierarchy. */
  panels: Panel[];
  /** Sectioned layout. When present, the UI renders these instead of `panels`. */
  sections?: DashboardSection[];
}

/** A bind from a panel to a named server-side provider + an opaque query object. */
export interface DataBinding {
  /** Provider name, e.g. 'durable.timeseries'. Resolved on the server. */
  provider: string;
  /** Opaque query passed through to the provider's `resolve`. */
  query?: Record<string, unknown>;
}

/** A deep-link out of a table cell (to the durable dashboard, a telescope trace, etc.). */
export interface LinkSpec {
  /** A URL template with `{key}` placeholders filled from the row, e.g. '/durable/runs/{runId}'. */
  href: string;
  /** When true, open in a new tab. */
  external?: boolean;
}

export interface Column {
  key: string;
  label: string;
  link?: LinkSpec;
}

export type Panel =
  | {
      kind: 'stat';
      title: string;
      data: DataBinding;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      accent?: string;
      /** When true, the provider also returns `spark: number[]` and the card draws a sparkline. */
      spark?: boolean;
      thresholds?: PanelThresholds;
    }
  | {
      kind: 'timeseries';
      title: string;
      data: DataBinding;
      series: string[];
      style?: 'area' | 'stacked';
    }
  | { kind: 'topN'; title: string; data: DataBinding; limit?: number }
  | { kind: 'table'; title: string; data: DataBinding; columns: Column[] }
  | {
      kind: 'distribution';
      title: string;
      data: DataBinding;
      markers?: Array<'p50' | 'p95' | 'p99'>;
      format?: 'duration' | 'number';
    }
  | {
      kind: 'gauge';
      title: string;
      data: DataBinding;
      min?: number;
      max?: number;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      thresholds?: PanelThresholds;
    }
  | { kind: 'breakdown'; title: string; data: DataBinding; style?: 'donut' | 'bar' };

/** A named server-side query a panel binds to. */
export interface DataProvider {
  /** Stable name referenced by a panel's `DataBinding.provider`, e.g. 'durable.timeseries'. */
  name: string;
  /**
   * Resolve a panel's data. `query` is the panel's `DataBinding.query`. Return value
   * shape is per panel kind:
   *  - stat         → `{ value: number; delta?: number; deltaLabel?: string; spark?: number[] }`
   *  - timeseries   → `{ rows: Array<{ label: string } & Record<string, number>> }`
   *  - topN         → `{ items: Array<{ label: string; value: number; id?: string }> }`
   *  - table        → `{ rows: Array<Record<string, unknown>> }`
   *  - distribution → `{ buckets: Array<{ label: string; count: number }>; p50?: number; p95?: number; p99?: number }`
   *  - gauge        → `{ value: number; min?: number; max?: number }`
   *  - breakdown    → `{ segments: Array<{ label: string; value: number; color?: string }> }`
   */
  resolve(query: Record<string, unknown> | undefined, ctx: ExtensionContext): Promise<unknown>;
}

/** Identity helper for authoring extensions with full type inference. */
export function defineTelescopeExtension(ext: TelescopeExtension): TelescopeExtension {
  return ext;
}
