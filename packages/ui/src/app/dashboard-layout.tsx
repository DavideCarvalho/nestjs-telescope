import { type ReactNode, useMemo } from 'react';
import { useHref, useLocation, useNavigate } from 'react-router-dom';
import { EmptyState } from '../aviary-kit/blocks/empty-state';
import { ErrorBoundary } from '../aviary-kit/blocks/error-boundary';
import {
  AlertIcon,
  ClockIcon,
  ConsoleIcon,
  FlowIcon,
  GridIcon,
  InboxIcon,
  ListIcon,
  ServerIcon,
} from '../aviary-kit/icons';
import { cn } from '../aviary-kit/lib/utils';
import { readShellConfig } from '../aviary-kit/shell-config';
import { AppShell, type NavItem, type NavSection } from '../aviary-kit/shell/app-shell';
import type { SearchCommand } from '../aviary-kit/shell/console-search';
import {
  RetentionIndicator,
  allEntryTypes,
  useLiveTail,
  useMeta,
  visibleEntryTypes,
} from '../react/index.js';
import {
  AiIcon,
  DashboardIcon,
  DownloadIcon,
  FlameIcon,
  PulseIcon,
  TraceIcon,
  TrashIcon,
} from './icons.js';
import { OrganizationPicker, useNoOrganization } from './organization-picker.js';

/** The id of the page's JSON config block (the server's `TELESCOPE_DASHBOARD_CONFIG_ID`). */
export const CONFIG_ELEMENT_ID = 'telescope-dashboard-config';

interface TopNavItem {
  to: string;
  label: string;
  end: boolean;
}

/** The fixed pages, in sidebar order (sections below). */
const NAV: TopNavItem[] = [
  { to: '/', label: 'Overview', end: true },
  { to: '/pulse', label: 'Pulse', end: false },
  { to: '/entries/exception', label: 'Exceptions', end: true },
  { to: '/entries', label: 'Entries', end: true },
  { to: '/traces', label: 'Traces', end: true },
  { to: '/ai', label: 'AI', end: false },
  { to: '/profiles', label: 'Profiles', end: false },
  { to: '/queues', label: 'Queues', end: false },
  { to: '/schedules', label: 'Schedules', end: false },
  { to: '/exports', label: 'Exports', end: false },
  { to: '/prunes', label: 'Prunes', end: false },
];

/**
 * Which fixed nav items to show given `meta.tracesEnabled`. The Traces page
 * (`#/traces`) only has content when the host wired a `traceContext` provider —
 * otherwise every entry's `trace_id` is null and the page is permanently empty,
 * so we drop the dead nav item. Mirrors `visibleEntryTypes`' watcher logic:
 *  - `tracesEnabled === undefined` → meta hasn't loaded yet; show Traces (no
 *    flash-of-hidden-nav).
 *  - only a POSITIVE `false` hides it. The route stays mounted, so a direct
 *    `#/traces` visit still resolves.
 *
 * Pure and order-preserving so it's trivially unit-testable.
 */
export function visibleTopNav(
  items: readonly TopNavItem[],
  tracesEnabled: boolean | undefined,
  profilingEnabled?: boolean | undefined,
): TopNavItem[] {
  return items.filter((item) => {
    // Only a POSITIVE `false` hides Traces (page would be permanently empty).
    if (item.to === '/traces' && tracesEnabled === false) return false;
    // Profiles is hidden unless profiling is POSITIVELY enabled — unlike Traces,
    // the page has no fallback content and the feature is off by default, so we
    // hide on undefined (meta still loading) too.
    if (item.to === '/profiles' && profilingEnabled !== true) return false;
    return true;
  });
}

/** Which sidebar section each fixed page sits in. */
const SECTION_OF: Record<string, string> = {
  '/': 'Monitor',
  '/pulse': 'Monitor',
  '/entries/exception': 'Monitor',
  '/entries': 'Explore',
  '/traces': 'Explore',
  '/ai': 'Explore',
  '/profiles': 'Explore',
  '/queues': 'Operations',
  '/schedules': 'Operations',
  '/exports': 'Data',
  '/prunes': 'Data',
};

const ICON_OF: Record<string, ReactNode> = {
  '/': <GridIcon />,
  '/pulse': <PulseIcon />,
  '/entries/exception': <AlertIcon />,
  '/entries': <ListIcon />,
  '/traces': <TraceIcon />,
  '/ai': <AiIcon />,
  '/profiles': <FlameIcon />,
  '/queues': <InboxIcon />,
  '/schedules': <ClockIcon />,
  '/exports': <DownloadIcon />,
  '/prunes': <TrashIcon />,
};

/** The nav id of a fixed page (`/entries/exception` → `exceptions`). */
function pageId(to: string): string {
  return to === '/' ? 'overview' : to === '/entries/exception' ? 'exceptions' : to.slice(1);
}

/** `decodeURIComponent`, or the raw segment on a malformed escape (`#/entries/%`): this runs in the
 *  layout, outside every page's error boundary, so it must never throw. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The sidebar item a location belongs to: a fixed page, a watcher (`watcher:<type>`) or a
 * contributed dashboard (`dashboard:<id>`). Entry detail pages light up Entries.
 */
export function activeNavId(pathname: string): string | undefined {
  if (pathname === '/' || pathname === '') return 'overview';
  if (pathname === '/entries/exception') return 'exceptions';
  if (pathname === '/entries' || pathname.startsWith('/entries/view/')) return 'entries';
  const watcher = /^\/entries\/([^/]+)$/.exec(pathname);
  if (watcher?.[1]) return `watcher:${decodeSegment(watcher[1])}`;
  const dashboard = /^\/ext\/([^/]+)$/.exec(pathname);
  if (dashboard?.[1]) return `dashboard:${decodeSegment(dashboard[1])}`;
  const first = pathname.split('/')[1];
  return first ? first : undefined;
}

/** The topbar's title for pages that are not a nav item of their own. */
function fallbackTitle(pathname: string): string {
  if (pathname.startsWith('/entries/view/')) return 'Entry';
  if (pathname.startsWith('/traces/')) return 'Trace';
  if (pathname === '/queues/metrics') return 'Queue metrics';
  return 'Telescope';
}

/** The topbar's live-tail toggle: a pulsing dot while live, a pause mark while paused. */
function LiveTailToggle(): React.JSX.Element {
  const { paused, setPaused } = useLiveTail();
  return (
    <button
      type="button"
      onClick={() => setPaused(!paused)}
      aria-pressed={paused}
      title={paused ? 'Resume live tail' : 'Pause live tail'}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors',
        paused
          ? 'border-warn/30 bg-warn/10 text-warn hover:bg-warn/15'
          : 'border-transparent text-dim hover:bg-hover hover:text-fg',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('size-[7px] rounded-full', paused ? 'bg-warn' : 'tele-live bg-good')}
      />
      {paused ? 'Paused' : 'Live'}
    </button>
  );
}

/** The telescope console's mark: the kit's telescope glyph. */
function LogoMark(): React.JSX.Element {
  return <ConsoleIcon icon="telescope" />;
}

/**
 * The telescope console: the Aviary shell (kit) around the routed pages — MONITOR (Overview,
 * Pulse, Exceptions) · EXPLORE (Entries, Traces, AI, Profiles) · OPERATIONS (Queues, Schedules) ·
 * DASHBOARDS (contributed) · WATCHERS (one dot per entry type, folded) · DATA (Exports, Prunes).
 * The page renders inside its own error boundary, reset on navigation.
 */
export function DashboardLayout({ children }: { children: ReactNode }): React.JSX.Element {
  // What the server put in the page: switcher, ⌘K search, viewer, sign-out (all optional).
  const shell = useMemo(() => readShellConfig(CONFIG_ELEMENT_ID), []);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // `#/` under the HashRouter, `/` under a MemoryRouter: hrefs are the router's own.
  const hrefPrefix = useHref('/').replace(/\/$/, '');
  // Watcher-driven nav: only show a type's link when its watcher is registered.
  // `meta.watchers` is undefined until /api/meta resolves (or on older servers),
  // in which case `visibleEntryTypes` shows everything — no flash-of-hidden-nav.
  const meta = useMeta();
  const noOrganization = useNoOrganization();
  const entryTypes = allEntryTypes(meta.data?.entryTypes);
  const watcherTypes = visibleEntryTypes(entryTypes, meta.data?.watchers);
  // Hide the Traces nav item when meta positively reports no traceContext: the
  // page would be permanently empty. Undefined meta → show it (same backward-
  // compatible fallback as the watcher-driven nav above).
  const topNav = visibleTopNav(NAV, meta.data?.tracesEnabled, meta.data?.profiling?.enabled);
  const dashboards = meta.data?.dashboards ?? [];

  const watchersOpen = activeNavId(pathname)?.startsWith('watcher:') ?? false;
  const nav: NavSection[] = (() => {
    const link = (id: string, label: string, to: string, icon: ReactNode): NavItem => ({
      id,
      label,
      icon,
      href: `${hrefPrefix}${to}`,
      onSelect: () => navigate(to),
    });
    const fixed = (section: string) =>
      topNav
        .filter((item) => SECTION_OF[item.to] === section)
        .map((item) => link(pageId(item.to), item.label, item.to, ICON_OF[item.to]));
    return [
      { section: 'Monitor', items: fixed('Monitor') },
      { section: 'Explore', items: fixed('Explore') },
      { section: 'Operations', items: fixed('Operations') },
      {
        section: 'Dashboards',
        items: dashboards.map((d) =>
          link(`dashboard:${d.id}`, d.label, `/ext/${d.id}`, <DashboardIcon />),
        ),
      },
      {
        section: 'Watchers',
        collapsible: true,
        defaultOpen: watchersOpen,
        items: watcherTypes.map((type) =>
          link(
            `watcher:${type.id}`,
            type.label,
            `/entries/${type.id}`,
            <span className="grid size-[15px] place-items-center" aria-hidden="true">
              <span className={cn('size-[7px] rounded-full', type.dot)} />
            </span>,
          ),
        ),
      },
      { section: 'Data', items: fixed('Data') },
    ];
  })();

  // ⌘K: this console's pages and entry types, listed above the cross-console hits.
  const commands: SearchCommand[] = [
    ...nav
      .filter((section) => section.section !== 'Watchers')
      .flatMap((section) =>
        section.items.map((item) => ({
          id: `page:${item.id}`,
          label: item.label,
          group: 'Pages',
          icon: item.icon,
          keywords: [section.section],
          onSelect: () => item.onSelect?.(),
        })),
      ),
    {
      id: 'page:queue-metrics',
      label: 'Queue metrics',
      group: 'Pages',
      icon: <ServerIcon />,
      keywords: ['Operations', 'queues'],
      onSelect: () => navigate('/queues/metrics'),
    },
    ...entryTypes.map((type) => ({
      id: `type:${type.id}`,
      label: type.label,
      group: 'Entry types',
      icon: (
        <span className="grid size-4 place-items-center" aria-hidden="true">
          <span className={cn('size-[7px] rounded-full', type.dot)} />
        </span>
      ),
      keywords: [type.id, 'watcher'],
      onSelect: () => navigate(`/entries/${type.id}`),
    })),
  ];

  const activeId = activeNavId(pathname);
  const activeItem = nav.flatMap((s) => s.items).find((item) => item.id === activeId);
  // A detail page (an entry, a trace) is titled for itself; its list stays lit in the sidebar.
  const title =
    pathname.startsWith('/entries/view/') || /^\/traces\/./.test(pathname)
      ? fallbackTitle(pathname)
      : (activeItem?.label ?? fallbackTitle(pathname));

  return (
    <AppShell
      brand={{
        name: 'telescope',
        subtitle: 'observability',
        mark: <LogoMark />,
        current: { title: 'Telescope', package: '@dudousxd/nestjs-telescope', icon: 'telescope' },
      }}
      nav={nav}
      activeId={activeId}
      shell={shell}
      title={title}
      commands={commands}
      searchPlaceholder="Jump to a page, or search by id or tag…"
      actions={
        <>
          <OrganizationPicker />
          <span className="hidden lg:flex">
            <RetentionIndicator />
          </span>
          <LiveTailToggle />
        </>
      }
    >
      <ErrorBoundary label={title} resetKeys={[pathname]} className="m-4 md:m-6">
        {noOrganization ? (
          <EmptyState
            className="mt-16"
            icon={<FlowIcon />}
            title="Choose an organization"
            description="Choose an organization to see its data."
          />
        ) : (
          children
        )}
      </ErrorBoundary>
    </AppShell>
  );
}
