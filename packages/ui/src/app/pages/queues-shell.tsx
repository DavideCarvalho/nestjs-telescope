import { NavLink, Outlet } from 'react-router-dom';

const SUB_TABS = [
  { to: '/queues', label: 'Manage', end: true },
  { to: '/queues/metrics', label: 'Metrics', end: false },
];

/** Shared shell for the Queues area: management (default) + metrics sub-tabs. */
export function QueuesShell(): JSX.Element {
  return (
    <div className="space-y-1">
      <div className="flex gap-1 border-b border-zinc-800 px-4 pt-3">
        {SUB_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              `rounded-t-md px-3 py-1.5 text-xs transition-colors ${
                isActive ? 'bg-zinc-900 text-emerald-300' : 'text-zinc-500 hover:text-zinc-300'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  );
}
