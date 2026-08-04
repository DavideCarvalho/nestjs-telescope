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

/**
 * A deep-link out of a table cell (to the durable dashboard, a telescope trace, etc.).
 *
 * @remarks Two hrefs conventions:
 *  - **In-app hash route** — an `href` starting with `#/` (e.g. `'#/traces/{traceId}'`)
 *    is a route inside the Telescope SPA itself. The UI renders it as a plain
 *    anchor; browsers treat a same-document `#`-only href as a same-document
 *    navigation (URL hash update + `hashchange`, no page reload), which the
 *    dashboard's `HashRouter` picks up — the same mechanism the built-in Entries
 *    table and Entry detail page already use for their own trace links. Leave
 *    `external` unset for these.
 *  - **Host-console link** — an absolute path with no `#` (e.g.
 *    `'/durable/runs/{runId}'`) targets a page in the HOST application (the app
 *    embedding/linking to Telescope), not a Telescope route. This is a real
 *    top-level navigation; set `external: true` when it should open in a new tab.
 *
 * The one confirmed in-app hash route today is the trace waterfall view:
 * `#/traces/{traceId}` (`traceId` is the row key to substitute), which renders
 * `TracePage` — the single-trace waterfall. Bridges that want to deep-link a
 * table row to "show me this trace" should target that exact shape.
 */
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
  /**
   * Turns this column's header into a sort control. Clicking it cycles
   * ascending → descending → unsorted and re-resolves the panel's provider with
   * `sort=<key>` + `dir=asc|desc` merged into the query — see
   * {@link readTableQuery}.
   *
   * Sorting is the provider's job, not the browser's: the UI holds one page, so
   * a client-side sort would order 50 rows out of 50,000 and present the result
   * as "the top of the list". Only mark a column sortable when the provider
   * actually honours `sort`; the header otherwise looks like a control that
   * silently does nothing.
   */
  sortable?: boolean;
  /**
   * Gives this column a filter box in the header. The typed text is committed on
   * Enter (or blur) and re-resolves the provider with `filter.<key>=<text>` —
   * see {@link TABLE_FILTER_PREFIX}. Matching semantics are entirely the
   * provider's to choose (substring, prefix, exact).
   */
  filterable?: boolean;
  /**
   * Lets a viewer hide this column from the table's column menu. Purely a
   * client-side display concern — a hidden column is not communicated to the
   * provider, which keeps returning it. The menu itself only appears when at
   * least one column opts in, so a table that declares none renders exactly as
   * it did before this flag existed.
   */
  hideable?: boolean;
}

/**
 * Drill-down: opt a chart-shaped panel into "clicking a bar/segment/bucket filters
 * this dashboard".
 *
 * The UI holds the current selection and re-resolves EVERY panel on the dashboard
 * with `param` set to the clicked item's id (or its label when the provider gave
 * no id) merged onto each panel's own `DataBinding.query`. So a provider opts in
 * by reading that one query key; a provider that ignores it renders exactly what
 * it renders today.
 *
 * Omit this and the panel is inert: the UI attaches no click handler at all, which
 * is the difference between "clicking does nothing" and "the cursor says it should".
 *
 * @example
 * { kind: 'topN', title: 'Busiest workflows', data: { provider: 'durable.top' },
 *   drilldown: { param: 'workflow' } }
 * // click "checkout" → every panel re-resolves with `?workflow=checkout`
 */
export interface PanelDrilldown {
  /** Query-parameter name the selection is written to. */
  param: string;
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
      /** Clicking a bucket filters the dashboard by its label. See {@link PanelDrilldown}. */
      drilldown?: PanelDrilldown;
    }
  | {
      kind: 'topN';
      title: string;
      data: DataBinding;
      limit?: number;
      /** Clicking a bar filters the dashboard by the item's `id` (or label). See {@link PanelDrilldown}. */
      drilldown?: PanelDrilldown;
    }
  | {
      kind: 'table';
      title: string;
      data: DataBinding;
      columns: Column[];
      /**
       * Opt into paged-table mode: the UI renders prev/next controls (+ "page X
       * of Y") and re-resolves this panel's provider with `query.page` (1-based)
       * and `query.limit` merged in on top of the panel's own static `data.query`.
       * The provider MUST then return `{ rows, total, page, limit }` instead of
       * a bare `{ rows }` — see {@link DataProvider.resolve}. Omit (or `false`)
       * for the existing bare-rows table, unchanged.
       */
      paged?: boolean;
    }
  | {
      kind: 'distribution';
      title: string;
      data: DataBinding;
      markers?: Array<'p50' | 'p95' | 'p99'>;
      format?: 'duration' | 'number';
      /** Clicking a bucket filters the dashboard by its label. See {@link PanelDrilldown}. */
      drilldown?: PanelDrilldown;
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
  | {
      kind: 'breakdown';
      title: string;
      data: DataBinding;
      style?: 'donut' | 'bar';
      /** Clicking a segment filters the dashboard by its label. See {@link PanelDrilldown}. */
      drilldown?: PanelDrilldown;
    };

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
   *  - table        → `{ rows: Array<Record<string, unknown>> }`, or — when the
   *                   panel declares `paged: true` — `{ rows, total, page, limit }`
   *                   (`page`/`limit` normally echo the requested `query.page` /
   *                   `query.limit`; `total` is the full, unpaginated row count so
   *                   the UI can compute "page X of Y")
   *
   * A `table` panel whose columns declare `sortable` / `filterable` additionally
   * merges `sort` + `dir` and `filter.<columnKey>` params into `query`. Read
   * them with {@link readTableQuery} rather than by hand — everything in `query`
   * arrives as a **string** off the URL, so `query.page > 1` is silently `false`
   * for `'2'`. A provider that ignores the new params is unaffected: the table
   * simply keeps returning rows in the provider's own order.
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
