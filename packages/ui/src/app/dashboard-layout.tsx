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
      ? 'bg-zinc-900 text-emerald-300'
      : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
  }`;
}

function watcherLinkClass({ isActive }: { isActive: boolean }): string {
  return `flex items-center gap-2 rounded px-3 py-1.5 text-xs ${
    isActive ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
  }`;
}

function LiveTailToggle(): JSX.Element {
  const { paused, setPaused } = useLiveTail();
  return (
    <button
      type="button"
      onClick={() => setPaused(!paused)}
      aria-pressed={paused}
      title={paused ? 'Resume live tail' : 'Pause live tail'}
      className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium uppercase tracking-wide transition-colors ${
        paused
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
          : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
      }`}
    >
      <span aria-hidden="true">{paused ? '⏸' : '●'}</span>
      {paused ? 'Paused' : 'Live'}
    </button>
  );
}

function ThemeToggle(): JSX.Element {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-pressed={!isDark}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="flex items-center gap-1.5 rounded border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
    >
      <span aria-hidden="true">{isDark ? '☾' : '☀'}</span>
      {isDark ? 'Dark' : 'Light'}
    </button>
  );
}

function PaletteHint({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Open command palette"
      aria-keyshortcuts="Meta+K Control+K"
      className="flex items-center gap-1.5 rounded border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
    >
      <span aria-hidden="true">⌘K</span>
    </button>
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
    <button
      type="button"
      onClick={onLogout}
      disabled={busy}
      title="Sign out"
      className="flex items-center gap-1.5 rounded border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span aria-hidden="true">⎋</span>
      Sign out
    </button>
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
    <div className="flex min-h-screen bg-zinc-950 font-mono text-sm text-zinc-200">
      <CommandPalette open={open} onClose={() => setOpen(false)} />
      <aside className="flex w-56 shrink-0 flex-col gap-6 border-r border-zinc-800 px-3 py-4">
        <span className="px-3 text-base font-semibold text-emerald-400">Telescope</span>
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
          <span className="px-3 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
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
        <header className="flex items-center justify-end gap-4 border-b border-zinc-800 px-4 py-2">
          <RetentionIndicator />
          <PaletteHint onClick={() => setOpen(true)} />
          <ThemeToggle />
          <LiveTailToggle />
          <LogoutButton />
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
