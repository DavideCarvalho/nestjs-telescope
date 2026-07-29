import type { ScheduledTask } from '../../client/index.js';
import { relativeTime, useSchedulesLive } from '../../react/index.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../react/ui/index.js';

const KIND_ACCENT: Record<ScheduledTask['kind'], string> = {
  cron: 'tint-brand',
  interval: 'tint-muted',
  timeout: 'text-warn tint-warn',
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

/**
 * Whether the task is currently active. `true` = started/enabled (will fire on
 * schedule); `false` = registered but STOPPED (won't fire — the thing a dev needs
 * to spot); `null` = unknowable (intervals/timeouts expose no state).
 */
function ActiveBadge({ running }: { running: ScheduledTask['running'] }): JSX.Element {
  if (running === null || running === undefined) {
    return (
      <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
        unknown
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${
        running ? 'tint-good' : 'tint-bad'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${running ? 'bg-good' : 'bg-bad'}`} />
      {running ? 'active' : 'stopped'}
    </span>
  );
}

function StatusBadge({ status }: { status: ScheduledTask['lastStatus'] }): JSX.Element {
  if (status === null) return <span className="text-muted-foreground">—</span>;
  const accent = status === 'completed' ? 'tint-good' : 'tint-bad';
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
    <TableRow className="border-t border-line/60 hover:bg-panel/40">
      <TableCell className="font-medium text-foreground">{task.name}</TableCell>
      <TableCell>
        <KindBadge kind={task.kind} />
      </TableCell>
      <TableCell>
        <ActiveBadge running={task.running} />
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{task.schedule}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatNextRun(task.nextRunAt)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {relativeTime(asMs(task.lastRunAt))}
      </TableCell>
      <TableCell className="text-xs tabular-nums text-muted-foreground">
        {formatDuration(task.lastDurationMs)}
      </TableCell>
      <TableCell>
        <StatusBadge status={task.lastStatus} />
      </TableCell>
    </TableRow>
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
  const activeCount = tasks.filter((t) => t.running === true).length;
  const stoppedCount = tasks.filter((t) => t.running === false).length;

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Scheduled tasks
        </h3>
        {tasks.length > 0 && (
          <div className="flex items-center gap-3 text-[10px] uppercase tracking-wide">
            <span className="text-good">{activeCount} active</span>
            {stoppedCount > 0 && <span className="text-bad">{stoppedCount} stopped</span>}
            <span className="text-muted-foreground">{tasks.length} total</span>
          </div>
        )}
      </div>

      {isLoading && <p className="px-1 py-2 text-xs text-muted-foreground">Loading schedules…</p>}
      {isError && <p className="px-1 py-2 text-xs text-bad">Failed to load schedules.</p>}

      {!isLoading && !isError && tasks.length === 0 && (
        <div className="rounded-lg border border-dashed border-line px-4 py-12 text-center text-xs text-muted-foreground">
          No scheduled tasks detected. Register a ScheduleManager (the @nestjs/schedule watcher) to
          populate this console.
        </div>
      )}

      {tasks.length > 0 && (
        <div className="rounded-lg border border-line">
          <Table className="min-w-[760px] text-left text-sm">
            <TableHeader>
              <TableRow className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => (
                <ScheduleRow key={`${task.kind}:${task.name}`} task={task} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
