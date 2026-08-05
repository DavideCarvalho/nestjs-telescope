import type { JSX } from 'react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Panel } from '../../client/types.js';
import type { ChartSelection } from '../../react/components/charts/chart-selection.js';
import { PanelView } from '../../react/components/extensions/panel-renderer.js';
import {
  type TableFilterState,
  type TableSortState,
  buildTableQuery,
} from '../../react/components/extensions/table-query.js';
import { Button } from '../../react/ui/button.js';
import { useExtensionData, useMeta } from '../../react/use-telescope-queries.js';
import { type StreamStatus, useTelescopeStream } from '../../react/use-telescope-stream.js';

/** Responsive grid column class per section `cols` value. */
const colClass: Record<2 | 3 | 4, string> = {
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
  4: 'md:grid-cols-2 lg:grid-cols-4',
};

/** Default page size a paged table panel requests when it hasn't fetched yet —
 *  matches the `DEFAULT_LIMIT` convention used by the core's own paged reads
 *  (traces, storage providers). */
const DEFAULT_PAGE_LIMIT = 50;

/**
 * The dashboard's current drill-down, set by clicking a chart on a panel that
 * declares `drilldown`.
 *
 * One selection per dashboard rather than one per panel: "clicked the checkout
 * workflow" is a statement about what the whole page is showing, and a per-panel
 * version would leave the stat cards next to the chart describing a different
 * population than the chart does.
 */
interface DashboardFocus {
  /** Query-parameter name, from the clicked panel's `drilldown.param`. */
  param: string;
  /** Value sent to every provider — the datum's id when it has one, else its label. */
  value: string;
  /** What to show in the chip; may carry the series name the value alone loses. */
  label: string;
}

/** The panel's drill-down declaration, if its kind can carry one. */
function drilldownOf(panel: Panel): { param: string } | undefined {
  return 'drilldown' in panel ? panel.drilldown : undefined;
}

/**
 * Small status badge driven by the SSE stream status. Green pulsing dot + "LIVE"
 * when connected; amber text when polling or reconnecting.
 */
function LiveBadge({ status }: { status: StreamStatus }): JSX.Element {
  const isLive = status === 'live';
  return (
    <span
      data-telescope-status={status}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
        isLive ? 'tint-good' : 'tint-warn'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${isLive ? 'animate-pulse bg-good' : 'bg-warn'}`}
      />
      {isLive ? 'live' : status}
    </span>
  );
}

/**
 * One panel, bound to its own extension data fetch. Each panel resolves its
 * `data.provider` (+ optional `data.query`) independently so dashboards with
 * many panels fan out into separate cached queries (React Query dedups identical
 * provider+query pairs). A failed fetch degrades to an inline error card rather
 * than blanking the whole dashboard.
 *
 * Paged tables (`panel.paged`, see the core `Panel` table variant) additionally
 * own the requested page here: `page` state merges `query.page`/`query.limit`
 * onto the panel's static `data.query`, so clicking prev/next re-resolves the
 * provider with a distinct query (a distinct React Query cache key) instead of
 * mutating the panel's declared query in place.
 *
 * Sort and filter state are threaded exactly the same way, and for the same
 * reason they are not held inside the table: a table panel renders one page of
 * the provider's result, so sorting it in the browser would order the 50 rows in
 * hand and present that as the top of the list. Changing either therefore has to
 * become a new provider query, which is state that belongs to whoever owns the
 * query — this component.
 *
 * The dashboard's drill-down `focus` merges the same way, onto EVERY panel — that
 * is what makes clicking one chart filter the page rather than just itself. It
 * merges *under* the table state, as the base the panel's own query contributes
 * to, so a focused table still sorts and pages within the focused set. With no
 * focus and no table state the query object is the panel's own, untouched, so a
 * dashboard declaring neither `drilldown` nor `sortable` issues byte-identical
 * requests to before.
 */
function BoundPanel({
  ext,
  panel,
  focus,
  onSelect,
}: {
  ext: string;
  panel: Panel;
  focus: DashboardFocus | null;
  /** Passed only for panels that declare `drilldown`; see {@link drilldownOf}. */
  onSelect?: (selection: ChartSelection) => void;
}): JSX.Element {
  const isPagedTable = panel.kind === 'table' && panel.paged === true;
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<TableSortState | undefined>(undefined);
  const [filters, setFilters] = useState<TableFilterState>({});
  // The focus is part of the panel's *base* query, not of its table state: it
  // scopes what the provider is asked for, and sort/filter/paging then apply
  // within that scope. Spread only when focused so `buildTableQuery` can still
  // hand back `panel.data.query` by identity for an untouched panel.
  const focusQuery = focus ? { [focus.param]: focus.value } : undefined;
  const baseQuery = focusQuery ? { ...panel.data.query, ...focusQuery } : panel.data.query;
  const query = buildTableQuery(baseQuery, {
    ...(isPagedTable ? { paging: { page, limit: DEFAULT_PAGE_LIMIT } } : {}),
    ...(sort ? { sort } : {}),
    filters,
  });
  const q = useExtensionData(ext, panel.data.provider, query);
  if (q.isError) {
    return (
      <div className="tint-bad rounded-lg border px-4 py-3 text-sm">
        Failed to load "{panel.title}".
      </div>
    );
  }
  return (
    <PanelView
      panel={panel}
      data={q.data}
      {...(isPagedTable ? { onPageChange: setPage, requestedPage: page } : {})}
      sort={sort}
      onSortChange={(next) => {
        // Back to page 1: "page 4 of the runs sorted by start time" has no
        // meaningful counterpart in a differently sorted result set, and landing
        // past the end of a shorter one shows an empty table.
        setPage(1);
        setSort(next);
      }}
      filters={filters}
      onFiltersChange={(next) => {
        setPage(1);
        setFilters(next);
      }}
      {...(onSelect ? { onSelect } : {})}
    />
  );
}

/**
 * Renders an extension-contributed dashboard in sections (each section has an
 * optional title and a responsive grid with a configurable column count). Falls
 * back to a single flat section for dashboards that only define `panels` (backward
 * compat with older extension registrations). The dashboard is looked up from
 * `/api/meta.dashboards` by the `:dashboardId` route param. The convention is
 * `"<extName>.<page>"` (e.g. `durable.workflows`), so the owning extension is the
 * prefix before the first dot — used to scope each panel's data fetch.
 *
 * The page also owns the drill-down selection: a click on a panel that declares
 * `drilldown` becomes a {@link DashboardFocus}, which every panel then re-resolves
 * against. Clicking the same value again clears it, so the way out of a drill-down
 * is the same gesture that got you in — plus the chip's Clear button, because a
 * filtered dashboard that does not say so reads as missing data.
 */
export function ExtensionDashboardPage(): JSX.Element {
  const { dashboardId } = useParams();
  const meta = useMeta();
  const { status } = useTelescopeStream();
  // Declared before the not-found return: hooks cannot sit behind a branch.
  const [focus, setFocus] = useState<DashboardFocus | null>(null);
  const dash = meta.data?.dashboards?.find((d) => d.id === dashboardId);
  if (!dash) {
    return <div className="p-6 text-sm text-muted-foreground">Dashboard not found.</div>;
  }
  const ext = dashboardId?.split('.')[0] ?? '';
  // Backward compat: dashboards without sections fall back to a single 2-column section.
  const sections = dash.sections ?? [{ panels: dash.panels, cols: 2 as const }];

  function select(param: string, selection: ChartSelection): void {
    const value = selection.id ?? selection.label;
    const label = selection.series ? `${selection.series} · ${selection.label}` : selection.label;
    setFocus((current) =>
      current?.param === param && current.value === value ? null : { param, value, label },
    );
  }

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-sm font-semibold text-foreground">{dash.label}</h2>
        <LiveBadge status={status} />
        {focus && (
          <span className="tint-brand inline-flex items-center gap-1 rounded border py-0.5 pl-1.5 text-[10px]">
            {focus.param}: {focus.label}
            <Button
              variant="ghost"
              size="xs"
              className="px-1 text-inherit"
              onClick={() => setFocus(null)}
            >
              Clear
            </Button>
          </span>
        )}
      </div>
      {sections.map((section, i) => (
        <section key={section.title ?? `s${i}`} className="mb-6">
          {section.title && (
            <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
              {section.title}
            </p>
          )}
          <div className={`grid grid-cols-1 gap-3 ${colClass[section.cols ?? 2]}`}>
            {section.panels.map((panel) => {
              const drilldown = drilldownOf(panel);
              return (
                <BoundPanel
                  key={`${panel.kind}-${panel.title}`}
                  ext={ext}
                  panel={panel}
                  focus={focus}
                  {...(drilldown
                    ? { onSelect: (s: ChartSelection) => select(drilldown.param, s) }
                    : {})}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
