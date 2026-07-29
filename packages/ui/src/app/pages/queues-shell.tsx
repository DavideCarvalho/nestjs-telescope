import { NavLink, Outlet } from 'react-router-dom';

const SUB_TABS = [
  { to: '/queues', label: 'Manage', end: true },
  { to: '/queues/metrics', label: 'Metrics', end: false },
];

/** Shared shell for the Queues area: management (default) + metrics sub-tabs. */
export function QueuesShell(): JSX.Element {
  return (
    <div className="space-y-1">
      <div className="flex gap-1 border-b border-line px-4 pt-3">
        {SUB_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              `rounded-t-md px-3 py-1.5 text-xs transition-colors ${
                isActive ? 'bg-panel text-brand' : 'text-muted-foreground hover:text-foreground'
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
