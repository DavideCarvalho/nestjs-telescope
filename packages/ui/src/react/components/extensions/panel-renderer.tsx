import type { JSX } from 'react';
import type { Panel } from '../../../client/types.js';
import { Button } from '../../ui/button.js';
import { AreaChartCard } from '../charts/area-chart-card.js';
import { BarChartCard } from '../charts/bar-chart-card.js';
import { BreakdownCard } from '../charts/breakdown-card.js';
import type { ChartSelection } from '../charts/chart-selection.js';
import { DistributionChartCard } from '../charts/distribution-chart-card.js';
import { GaugeCard } from '../charts/gauge-card.js';
import { StackedAreaChartCard } from '../charts/stacked-area-chart-card.js';
import { PanelTable } from './panel-table.js';
import { StatCard } from './stat-card.js';
import type { PanelRow } from './table-features.js';
import type { TableFilterState, TableSortState } from './table-query.js';

function formatStat(value: number, format?: 'number' | 'percent' | 'duration' | 'rate'): string {
  if (format === 'percent') return `${Math.round(value * 100)}%`;
  if (format === 'duration')
    return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
  if (format === 'rate') return `${new Intl.NumberFormat().format(Math.round(value))}/hr`;
  return new Intl.NumberFormat().format(value);
}

/**
 * Narrows a table provider's resolved payload to its rows.
 *
 * A guard rather than a cast: `data` is literally whatever came back over HTTP
 * from an extension nobody in this package controls, and every field has a safe
 * absent behaviour — a provider that returns `null`, or `{ rows: 'soon' }` while
 * it is being written, renders the empty state instead of throwing inside the
 * table instance where the stack says nothing about which panel is at fault.
 */
function readPanelRows(data: unknown): PanelRow[] {
  if (typeof data !== 'object' || data === null || !('rows' in data)) return [];
  const rows = data.rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is PanelRow => typeof row === 'object' && row !== null);
}

/** Reads a number off a resolved payload, or `undefined` when it is missing or
 *  isn't one — `NaN` reaching `Math.ceil` is a "Page 1 of NaN" indicator. */
function readNumber(data: unknown, key: string): number | undefined {
  if (typeof data !== 'object' || data === null || !(key in data)) return undefined;
  const value = Reflect.get(data, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The paged-table payload — `{ rows, total, page, limit }` — with each field
 *  falling back to what a bare `{ rows }` implies. */
function readPagedTable(data: unknown): {
  rows: PanelRow[];
  total: number;
  page: number;
  limit: number;
} {
  const rows = readPanelRows(data);
  return {
    rows,
    total: readNumber(data, 'total') ?? rows.length,
    page: readNumber(data, 'page') ?? 1,
    limit: readNumber(data, 'limit') ?? 0,
  };
}

/** Shared empty-state card so a provider that resolves with no rows reads as
 *  "nothing happened in this window" rather than a blank/broken panel. */
function EmptyPanel({ title }: { title: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-panel/40">
      <p className="border-b border-line px-4 py-2 text-xs font-medium text-foreground">{title}</p>
      <p className="px-4 py-8 text-center text-xs text-muted-foreground">No data in this window.</p>
    </div>
  );
}

/**
 * Prev/next + "page X of Y" controls for a paged table panel. Purely
 * presentational — the caller (the dashboard's `BoundPanel`) owns the actual
 * page state and re-resolves the provider; this just reports intent.
 */
function PagerControls({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange?: (page: number) => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
      <Button
        variant="outline"
        size="xs"
        disabled={page <= 1}
        onClick={() => onPageChange?.(page - 1)}
        className="px-1.5 text-muted-foreground"
      >
        Prev
      </Button>
      <span>
        Page {page} of {totalPages}
      </span>
      <Button
        variant="outline"
        size="xs"
        disabled={page >= totalPages}
        onClick={() => onPageChange?.(page + 1)}
        className="px-1.5 text-muted-foreground"
      >
        Next
      </Button>
    </div>
  );
}

/** Pure view: render a panel from already-resolved data. */
export function PanelView({
  panel,
  data,
  onPageChange,
  requestedPage,
  sort,
  onSortChange,
  filters,
  onFiltersChange,
  onSelect,
}: {
  panel: Panel;
  data: unknown;
  /** Paged tables only: called with the requested 1-based page on prev/next. */
  onPageChange?: (page: number) => void;
  /**
   * Paged tables only: the page the caller has ASKED for, which takes precedence over the page the
   * response reports.
   *
   * The two are normally the same, and when they are this changes nothing. They diverge when a
   * provider ignores `query.page` — and driving the control off the response there does not merely
   * show a stale number, it wedges the pager permanently: the handler computes `page + 1` from the
   * pinned page, so the second click re-requests the page the caller is already on, the state does
   * not change, nothing re-renders, and neither button ever does anything again short of a reload.
   * That is a real incident (`@dudousxd/nestjs-agent-telescope`'s providers read `?page=2` as a
   * string and answered page 1 for every request).
   *
   * Preferring the requested page keeps every click moving, so the worst a broken provider can do
   * is fail to change the rows — visible, and recoverable with Prev.
   */
  requestedPage?: number | undefined;
  /**
   * Tables only. Sort and filter state live with the caller for the same reason
   * `page` does: changing either has to re-resolve the provider, which is the
   * caller's query, not this view's. Absent means "unsorted / unfiltered", which
   * is exactly what a panel declaring no `sortable` or `filterable` column
   * renders with.
   */
  sort?: TableSortState | undefined;
  onSortChange?: (sort: TableSortState | undefined) => void;
  filters?: TableFilterState | undefined;
  onFiltersChange?: (filters: TableFilterState) => void;
  /**
   * Drill-down: called when a chart-shaped panel is clicked. The view stays pure —
   * it reports what was clicked and the caller decides what that filters. Omit it
   * and no chart gets a click handler, which is the behaviour of every panel that
   * does not declare `drilldown`.
   */
  onSelect?: (selection: ChartSelection) => void;
}): JSX.Element | null {
  // Spread rather than passed: under `exactOptionalPropertyTypes` an explicit
  // `undefined` is not assignable to the cards' optional handlers.
  const selectProps = onSelect ? { onSelect } : {};
  switch (panel.kind) {
    case 'stat': {
      const d = (data ?? {}) as {
        value?: number;
        delta?: number;
        deltaLabel?: string;
        spark?: number[];
      };
      return (
        <StatCard
          label={panel.title}
          value={formatStat(d.value ?? 0, panel.format)}
          {...(d.value !== undefined ? { currentValue: d.value } : {})}
          {...(d.delta !== undefined ? { delta: d.delta } : {})}
          {...(d.deltaLabel ? { deltaLabel: d.deltaLabel } : {})}
          {...(panel.spark && d.spark ? { spark: d.spark } : {})}
          {...(panel.thresholds ? { thresholds: panel.thresholds } : {})}
          {...(panel.accent ? { accent: panel.accent } : {})}
        />
      );
    }
    case 'distribution': {
      const d = (data ?? {}) as {
        buckets?: { label: string; count: number }[];
        p50?: number;
        p95?: number;
        p99?: number;
      };
      return (
        <DistributionChartCard
          title={panel.title}
          buckets={d.buckets ?? []}
          {...(d.p50 !== undefined ? { p50: d.p50 } : {})}
          {...(d.p95 !== undefined ? { p95: d.p95 } : {})}
          {...(d.p99 !== undefined ? { p99: d.p99 } : {})}
          {...selectProps}
        />
      );
    }
    case 'gauge': {
      const d = (data ?? {}) as { value?: number; min?: number; max?: number };
      return (
        <GaugeCard
          title={panel.title}
          value={d.value ?? 0}
          {...(panel.min !== undefined ? { min: panel.min } : {})}
          {...(panel.max !== undefined ? { max: panel.max } : {})}
        />
      );
    }
    case 'breakdown': {
      const d = (data ?? {}) as { segments?: { label: string; value: number; color?: string }[] };
      return (
        <BreakdownCard
          title={panel.title}
          segments={d.segments ?? []}
          {...(panel.style ? { style: panel.style } : {})}
          {...selectProps}
        />
      );
    }
    case 'timeseries': {
      const rows =
        (data as { rows?: Array<{ label: string } & Record<string, number>> })?.rows ?? [];
      const primary = panel.series[0];
      return panel.style === 'stacked' ? (
        <StackedAreaChartCard
          title={panel.title}
          data={rows}
          series={panel.series}
          {...selectProps}
        />
      ) : (
        <AreaChartCard
          title={panel.title}
          data={rows.map((r) => ({
            label: r.label,
            value: primary ? Number(r[primary] ?? 0) : 0,
          }))}
          {...selectProps}
        />
      );
    }
    case 'topN': {
      const items =
        (data as { items?: Array<{ label: string; value: number; id?: string }> })?.items ?? [];
      const limited = panel.limit ? items.slice(0, panel.limit) : items;
      if (limited.length === 0) return <EmptyPanel title={panel.title} />;
      return (
        <BarChartCard
          title={panel.title}
          data={limited}
          horizontal
          truncateLabel={32}
          {...selectProps}
        />
      );
    }
    case 'table': {
      // One `<PanelTable>` for both variants — the paged one only adds the pager
      // to the card header and lets the rows scroll under a pinned header, since
      // it is the variant whose row count is unbounded from the panel's side.
      const table = (
        <PanelTable
          columns={panel.columns}
          rows={readPanelRows(data)}
          scrolls={panel.paged === true}
          sort={sort}
          {...(onSortChange ? { onSortChange } : {})}
          filters={filters}
          {...(onFiltersChange ? { onFiltersChange } : {})}
        />
      );
      if (panel.paged) {
        const { rows, total, page, limit } = readPagedTable(data);
        const totalPages = Math.max(1, Math.ceil(total / (limit || rows.length || 1)));
        return (
          <div className="rounded-lg border border-line bg-panel/40">
            <div className="flex items-center justify-between border-b border-line px-4 py-2">
              <p className="text-xs font-medium text-foreground">{panel.title}</p>
              <PagerControls
                page={requestedPage ?? page}
                totalPages={totalPages}
                {...(onPageChange ? { onPageChange } : {})}
              />
            </div>
            {table}
          </div>
        );
      }
      return (
        <div className="rounded-lg border border-line bg-panel/40">
          <p className="border-b border-line px-4 py-2 text-xs font-medium text-foreground">
            {panel.title}
          </p>
          {table}
        </div>
      );
    }
    default:
      return null;
  }
}
