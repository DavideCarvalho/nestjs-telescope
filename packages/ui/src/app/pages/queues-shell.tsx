import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '../../aviary-kit/lib/utils';
import { TelescopePage } from '../page-chrome.js';

const SUB_TABS = [
  { to: '/queues', label: 'Manage', end: true },
  { to: '/queues/metrics', label: 'Metrics', end: false },
];

/** Shared shell for the Queues area: management (default) + metrics sub-tabs. */
export function QueuesShell(): React.JSX.Element {
  return (
    <TelescopePage
      title="Queues"
      description="Live queues with their jobs and actions, and failure and throughput metrics."
    >
      <nav aria-label="Queues" className="flex gap-1 border-b border-border">
        {SUB_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                '-mb-px border-b-2 px-3 py-2 text-[12.5px] font-medium transition-colors',
                isActive ? 'border-primary text-fg' : 'border-transparent text-dim hover:text-fg',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </TelescopePage>
  );
}
