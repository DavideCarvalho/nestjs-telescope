import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  ENTRY_TYPES,
  RetentionIndicator,
  allEntryTypes,
  useLiveTail,
  useMeta,
  visibleEntryTypes,
} from '../react/index.js';
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../react/ui/index.js';
import { useAuthOptional } from './auth-context.js';
import { CommandPalette, usePalette } from './command-palette.js';
import { useTheme } from './theme-context.js';

interface TopNavItem {
  to: string;
  label: string;
  end: boolean;
}

const NAV: TopNavItem[] = [
  { to: '/', label: 'Overview', end: true },
  { to: '/entries', label: 'Entries', end: true },
  { to: '/traces', label: 'Traces', end: true },
  { to: '/pulse', label: 'Pulse', end: false },
  { to: '/queues', label: 'Queues', end: false },
  { to: '/schedules', label: 'Schedules', end: false },
  { to: '/prunes', label: 'Prunes', end: false },
  { to: '/exports', label: 'Exports', end: false },
  { to: '/profiles', label: 'Profiles', end: false },
];

/**
 * Which top-level nav items to show given `meta.tracesEnabled`. The Traces page
 * (`#/traces`) only has content when the host wired a `traceContext` provider —
 * otherwise every entry's `trace_id` is null and the page is permanently empty,
 * so we drop the dead nav item. Mirrors `visibleEntryTypes`' watcher logic:
 *  - `tracesEnabled === undefined` → meta hasn't loaded or is from an older
 *    server that predates the field; show Traces (no flash-of-hidden-nav, and
 *    old servers keep working).
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
    // hide on undefined too (older servers without the field never show it).
    if (item.to === '/profiles' && profilingEnabled !== true) return false;
    return true;
  });
}

function topLinkClass({ isActive }: { isActive: boolean }): string {
  return `block rounded px-3 py-1.5 text-xs uppercase tracking-wide ${
    isActive
      ? 'bg-panel-2 text-brand'
      : 'text-muted-foreground hover:bg-panel hover:text-foreground'
  }`;
}

function watcherLinkClass({ isActive }: { isActive: boolean }): string {
  return `flex items-center gap-2 rounded px-3 py-1.5 text-xs ${
    isActive
      ? 'bg-panel-2 text-foreground'
      : 'text-muted-foreground hover:bg-panel hover:text-foreground'
  }`;
}

function LiveTailToggle(): JSX.Element {
  const { paused, setPaused } = useLiveTail();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={paused ? 'warn' : 'good'}
            onClick={() => setPaused(!paused)}
            aria-pressed={paused}
            className="uppercase tracking-wide"
          >
            <span aria-hidden="true">{paused ? '⏸' : '●'}</span>
            {paused ? 'Paused' : 'Live'}
          </Button>
        }
      />
      <TooltipContent>{paused ? 'Resume live tail' : 'Pause live tail'}</TooltipContent>
    </Tooltip>
  );
}

function ThemeToggle(): JSX.Element {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button onClick={toggleTheme} aria-pressed={!isDark}>
            <span aria-hidden="true">{isDark ? '☾' : '☀'}</span>
            {isDark ? 'Dark' : 'Light'}
          </Button>
        }
      />
      <TooltipContent>{isDark ? 'Switch to light theme' : 'Switch to dark theme'}</TooltipContent>
    </Tooltip>
  );
}

function PaletteHint({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            onClick={onClick}
            aria-label="Open command palette"
            aria-keyshortcuts="Meta+K Control+K"
            className="text-muted-foreground hover:text-foreground"
          >
            <span aria-hidden="true">⌘K</span>
          </Button>
        }
      />
      <TooltipContent>Open command palette (⌘K)</TooltipContent>
    </Tooltip>
  );
}

/**
 * Sign-out affordance, shown only when an AuthProvider has resolved an
 * authenticated session. Absent in disabled/no-provider contexts so the
 * no-auth header stays pixel-identical to today.
 */
function LogoutButton(): JSX.Element | null {
  const auth = useAuthOptional();
  const [busy, setBusy] = useState(false);
  if (auth === null || auth.phase !== 'app') return null;

  async function onLogout(): Promise<void> {
    if (auth === null) return;
    setBusy(true);
    try {
      await auth.logout();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={onLogout} disabled={busy} title="Sign out">
      <span aria-hidden="true">⎋</span>
      Sign out
    </Button>
  );
}

export function DashboardLayout({ children }: { children: React.ReactNode }): JSX.Element {
  const { open, setOpen } = usePalette();
  // Watcher-driven nav: only show a type's link when its watcher is registered.
  // `meta.watchers` is undefined until /api/meta resolves (or on older servers),
  // in which case `visibleEntryTypes` shows everything — no flash-of-hidden-nav.
  const meta = useMeta();
  const watcherTypes = visibleEntryTypes(allEntryTypes(meta.data?.entryTypes), meta.data?.watchers);
  // Hide the Traces nav item when meta positively reports no traceContext: the
  // page would be permanently empty. Undefined meta → show it (same backward-
  // compatible fallback as the watcher-driven nav above).
  const topNav = visibleTopNav(NAV, meta.data?.tracesEnabled, meta.data?.profiling?.enabled);
  return (
    <div className="flex min-h-screen bg-background font-mono text-sm text-foreground">
      <CommandPalette open={open} onClose={() => setOpen(false)} />
      <aside className="flex w-56 shrink-0 flex-col gap-6 border-r border-line px-3 py-4">
        <span className="px-3 text-base font-semibold text-brand">Telescope</span>
        <nav className="flex flex-col gap-1">
          {topNav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={topLinkClass}>
              {item.label}
            </NavLink>
          ))}
          {(meta.data?.dashboards ?? []).map((d) => (
            <NavLink key={d.id} to={`/ext/${d.id}`} className={topLinkClass}>
              {d.label}
            </NavLink>
          ))}
        </nav>
        <nav className="flex flex-col gap-1">
          <span className="px-3 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Watchers
          </span>
          {watcherTypes.map((type) => (
            <NavLink key={type.id} to={`/entries/${type.id}`} className={watcherLinkClass}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${type.dot}`} aria-hidden="true" />
              {type.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-4 border-b border-line px-4 py-2">
          <TooltipProvider delay={200}>
            <RetentionIndicator />
            <PaletteHint onClick={() => setOpen(true)} />
            <ThemeToggle />
            <LiveTailToggle />
            <LogoutButton />
          </TooltipProvider>
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
