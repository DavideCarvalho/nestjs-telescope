import type { JSX } from 'react';
import { useParams } from 'react-router-dom';
import type { Panel } from '../../client/types.js';
import { PanelView } from '../../react/components/extensions/panel-renderer.js';
import { useExtensionData, useMeta } from '../../react/use-telescope-queries.js';

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
        Failed to load “{panel.title}”.
      </div>
    );
  }
  return <PanelView panel={panel} data={q.data} />;
}

/**
 * Renders an extension-contributed dashboard's panels in a responsive grid. The
 * dashboard is looked up from `/api/meta.dashboards` by the `:dashboardId` route
 * param. The dashboard-id convention is `"<extName>.<page>"` (e.g.
 * `durable.workflows`), so the owning extension is the prefix before the first
 * dot — used to scope each panel's data fetch.
 */
export function ExtensionDashboardPage(): JSX.Element {
  const { dashboardId } = useParams();
  const meta = useMeta();
  const dash = meta.data?.dashboards?.find((d) => d.id === dashboardId);
  if (!dash) {
    return <div className="p-6 text-sm text-zinc-400">Dashboard not found.</div>;
  }
  const ext = dashboardId?.split('.')[0] ?? '';
  return (
    <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
      {dash.panels.map((panel, i) => (
        <BoundPanel key={i} ext={ext} panel={panel} />
      ))}
    </div>
  );
}
