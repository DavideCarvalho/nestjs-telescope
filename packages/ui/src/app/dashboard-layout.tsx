import { NavLink } from 'react-router-dom';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/entries', label: 'Entries', end: false },
  { to: '/pulse', label: 'Pulse', end: false },
  { to: '/queues', label: 'Queues', end: false },
];

export function DashboardLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="min-h-screen bg-zinc-950 font-mono text-sm text-zinc-200">
      <header className="flex items-center gap-6 border-b border-zinc-800 px-6 py-3">
        <span className="text-base font-semibold text-emerald-400">Telescope</span>
        <nav className="flex gap-4">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `text-xs uppercase tracking-wide ${isActive ? 'text-emerald-300' : 'text-zinc-500 hover:text-zinc-300'}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
