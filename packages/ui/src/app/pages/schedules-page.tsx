import type { ScheduledTask } from '../../client/index.js';
import { relativeTime, useSchedulesLive } from '../../react/index.js';

const KIND_ACCENT: Record<ScheduledTask['kind'], string> = {
  cron: 'text-emerald-300 bg-emerald-500/10',
  interval: 'text-sky-300 bg-sky-500/10',
  timeout: 'text-amber-300 bg-amber-500/10',
};

function KindBadge({ kind }: { kind: ScheduledTask['kind'] }): JSX.Element {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${KIND_ACCENT[kind]}`}
    >
      {kind}
    </span>
  );
}

function StatusBadge({ status }: { status: ScheduledTask['lastStatus'] }): JSX.Element {
  if (status === null) return <span className="text-zinc-600">—</span>;
  const accent =
    status === 'completed' ? 'text-emerald-300 bg-emerald-500/10' : 'text-red-300 bg-red-500/10';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${accent}`}>
      {status}
    </span>
  );
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Next-run is an ISO string in the future; relativeTime renders past deltas,
 *  so show the absolute local time for the next fire. */
function formatNextRun(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function ScheduleRow({ task }: { task: ScheduledTask }): JSX.Element {
  return (
    <tr className="border-t border-zinc-800/60 hover:bg-zinc-900/40">
      <td className="px-3 py-2 font-medium text-zinc-100">{task.name}</td>
      <td className="px-3 py-2">
        <KindBadge kind={task.kind} />
      </td>
      <td className="px-3 py-2 font-mono text-xs text-zinc-400">{task.schedule}</td>
      <td className="px-3 py-2 text-xs text-zinc-400">{formatNextRun(task.nextRunAt)}</td>
      <td className="px-3 py-2 text-xs text-zinc-400">{relativeTime(asMs(task.lastRunAt))}</td>
      <td className="px-3 py-2 text-xs tabular-nums text-zinc-400">
        {formatDuration(task.lastDurationMs)}
      </td>
      <td className="px-3 py-2">
        <StatusBadge status={task.lastStatus} />
      </td>
    </tr>
  );
}

function asMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function SchedulesPage(): JSX.Element {
  const { data, isLoading, isError } = useSchedulesLive();
  const tasks = data?.tasks ?? [];

  return (
    <div className="space-y-3 p-4">
      <h3 className="px-1 text-[10px] uppercase tracking-wide text-zinc-500">Scheduled tasks</h3>

      {isLoading && <p className="px-1 py-2 text-xs text-zinc-600">Loading schedules…</p>}
      {isError && <p className="px-1 py-2 text-xs text-red-400">Failed to load schedules.</p>}

      {!isLoading && !isError && tasks.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-12 text-center text-xs text-zinc-600">
          No scheduled tasks detected. Register a ScheduleManager (the @nestjs/schedule watcher) to
          populate this console.
        </div>
      )}

      {tasks.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-zinc-500">
                <th className="px-3 py-2 font-normal">Name</th>
                <th className="px-3 py-2 font-normal">Kind</th>
                <th className="px-3 py-2 font-normal">Schedule</th>
                <th className="px-3 py-2 font-normal">Next run</th>
                <th className="px-3 py-2 font-normal">Last run</th>
                <th className="px-3 py-2 font-normal">Duration</th>
                <th className="px-3 py-2 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <ScheduleRow key={`${task.kind}:${task.name}`} task={task} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
