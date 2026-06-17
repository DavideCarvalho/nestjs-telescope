import type { JSX } from 'react';
import { useParams } from 'react-router-dom';
import type { Panel } from '../../client/types.js';
import { PanelView } from '../../react/components/extensions/panel-renderer.js';
import { useExtensionData, useMeta } from '../../react/use-telescope-queries.js';
import { type StreamStatus, useTelescopeStream } from '../../react/use-telescope-stream.js';

/** Responsive grid column class per section `cols` value. */
const colClass: Record<2 | 3 | 4, string> = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
};

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
        isLive ? 'bg-emerald-950/60 text-emerald-400' : 'bg-amber-950/60 text-amber-400'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          isLive ? 'animate-pulse bg-emerald-400' : 'bg-amber-400'
        }`}
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
 */
function BoundPanel({ ext, panel }: { ext: string; panel: Panel }): JSX.Element {
  const q = useExtensionData(ext, panel.data.provider, panel.data.query);
  if (q.isError) {
    return (
      <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
        Failed to load "{panel.title}".
      </div>
    );
  }
  return <PanelView panel={panel} data={q.data} />;
}

/**
 * Renders an extension-contributed dashboard in sections (each section has an
 * optional title and a responsive grid with a configurable column count). Falls
 * back to a single flat section for dashboards that only define `panels` (backward
 * compat with older extension registrations). The dashboard is looked up from
 * `/api/meta.dashboards` by the `:dashboardId` route param. The convention is
 * `"<extName>.<page>"` (e.g. `durable.workflows`), so the owning extension is the
 * prefix before the first dot — used to scope each panel's data fetch.
 */
export function ExtensionDashboardPage(): JSX.Element {
  const { dashboardId } = useParams();
  const meta = useMeta();
  const { status } = useTelescopeStream();
  const dash = meta.data?.dashboards?.find((d) => d.id === dashboardId);
  if (!dash) {
    return <div className="p-6 text-sm text-zinc-400">Dashboard not found.</div>;
  }
  const ext = dashboardId?.split('.')[0] ?? '';
  // Backward compat: dashboards without sections fall back to a single 2-column section.
  const sections = dash.sections ?? [{ panels: dash.panels, cols: 2 as const }];
  return (
    <div className="p-4">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-sm font-semibold text-zinc-200">{dash.label}</h2>
        <LiveBadge status={status} />
      </div>
      {sections.map((section, i) => (
        <section key={section.title ?? `s${i}`} className="mb-6">
          {section.title && (
            <p className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500">
              {section.title}
            </p>
          )}
          <div className={`grid grid-cols-1 gap-3 ${colClass[section.cols ?? 2]}`}>
            {section.panels.map((panel) => (
              <BoundPanel key={`${panel.kind}-${panel.title}`} ext={ext} panel={panel} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
