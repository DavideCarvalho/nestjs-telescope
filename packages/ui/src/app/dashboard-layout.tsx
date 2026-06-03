import { NavLink } from 'react-router-dom';
import { ENTRY_TYPES } from '../react/index.js';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/entries', label: 'Entries', end: true },
  { to: '/pulse', label: 'Pulse', end: false },
  { to: '/queues', label: 'Queues', end: false },
];

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

export function DashboardLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-screen bg-zinc-950 font-mono text-sm text-zinc-200">
      <aside className="flex w-56 shrink-0 flex-col gap-6 border-r border-zinc-800 px-3 py-4">
        <span className="px-3 text-base font-semibold text-emerald-400">Telescope</span>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={topLinkClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <nav className="flex flex-col gap-1">
          <span className="px-3 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
            Watchers
          </span>
          {ENTRY_TYPES.map((type) => (
            <NavLink key={type.id} to={`/entries/${type.id}`} className={watcherLinkClass}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${type.dot}`} aria-hidden="true" />
              {type.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
