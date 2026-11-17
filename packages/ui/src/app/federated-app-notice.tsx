import { useApps } from '../react/index.js';

/**
 * Pages answered by this console's own process (its live queues, scheduler, pruner, extensions).
 * Recorded profiles are read from the store like entries, so the Profiles page is not one.
 */
function isProcessPage(pathname: string): boolean {
  return (
    pathname === '/queues' ||
    pathname === '/queues/' ||
    pathname.startsWith('/schedules') ||
    pathname.startsWith('/prunes') ||
    pathname.startsWith('/ext/')
  );
}

/**
 * On a federated console, with a federated app in view: says that a page run by an app's own
 * process (live queues, schedules, prune runs, extension panels) does not show that app,
 * since the console only reads its store. Nothing elsewhere.
 */
export function FederatedAppNotice({ pathname }: { pathname: string }): React.JSX.Element | null {
  const { data } = useApps();
  if (!data?.federation?.selected || !isProcessPage(pathname)) return null;
  const app = data.apps.find((a) => a.id === data.selected)?.label ?? data.selected ?? 'This app';
  return (
    <p
      role="note"
      className="mb-4 rounded border border-line bg-panel-2 px-3 py-2 text-xs text-muted-foreground"
    >
      {app} is a federated app: this console reads its own store, so this page, which runs in an
      app's process, can't show it. Open {app}'s own console for its live queues, schedules and
      prune runs, and to arm the profiler; replay and EXPLAIN also run there.
    </p>
  );
}
