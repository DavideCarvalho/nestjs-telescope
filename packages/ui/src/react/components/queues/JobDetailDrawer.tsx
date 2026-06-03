import { useEffect } from 'react';
import type { QueueCapabilities, QueueJobDetail, QueueState } from '../../../client/index.js';
import { useQueueJob } from '../../use-telescope-queries.js';
import { JobActions } from './JobActions.js';
import { relativeTime } from './queue-format.js';

function prettyJson(value: unknown): string {
  if (value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function JsonBlock({ label, value }: { label: string; value: unknown }): JSX.Element {
  return (
    <section>
      <h4 className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">{label}</h4>
      <pre className="overflow-auto rounded bg-zinc-950 p-2.5 text-[11px] leading-relaxed text-zinc-300 ring-1 ring-zinc-800">
        {prettyJson(value)}
      </pre>
    </section>
  );
}

function MetaRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-zinc-900 py-1 first:border-0">
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
      <span className="tabular-nums text-zinc-300">{value}</span>
    </div>
  );
}

function timestampLabel(value: number | null): string {
  if (value == null) return '—';
  return `${new Date(value).toLocaleString()} (${relativeTime(value)})`;
}

function DetailBody({
  detail,
  capabilities,
  driver,
  queue,
  state,
  onClose,
}: {
  detail: QueueJobDetail;
  capabilities: QueueCapabilities | undefined;
  driver: string;
  queue: string;
  state: QueueState;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-emerald-400">{detail.name || 'job'}</span>
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] capitalize text-zinc-300">
            {detail.state}
          </span>
        </div>
        <div className="font-mono text-[11px] text-zinc-500">{detail.id}</div>
      </header>

      <JobActions
        capabilities={capabilities}
        driver={driver}
        queue={queue}
        id={detail.id}
        state={state}
        onDone={onClose}
      />

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
        <MetaRow
          label="Attempts"
          value={
            detail.maxAttempts != null
              ? `${detail.attemptsMade}/${detail.maxAttempts}`
              : `${detail.attemptsMade}`
          }
        />
        <MetaRow label="Progress" value={detail.progress != null ? `${detail.progress}` : '—'} />
        <MetaRow label="Created" value={timestampLabel(detail.timestamp)} />
        <MetaRow label="Processed" value={timestampLabel(detail.processedOn)} />
        <MetaRow label="Finished" value={timestampLabel(detail.finishedOn)} />
      </div>

      {detail.failedReason && (
        <section>
          <h4 className="mb-1 text-[10px] uppercase tracking-wide text-red-400">Failed reason</h4>
          <p className="rounded bg-red-500/5 px-2.5 py-2 text-[11px] text-red-300 ring-1 ring-red-500/20">
            {detail.failedReason}
          </p>
        </section>
      )}

      <JsonBlock label="Payload (data)" value={detail.data} />
      <JsonBlock label="Options (opts)" value={detail.opts} />
      {detail.returnValue !== undefined && detail.returnValue !== null && (
        <JsonBlock label="Return value" value={detail.returnValue} />
      )}

      {detail.stacktrace && detail.stacktrace.length > 0 && (
        <section>
          <h4 className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Stacktrace</h4>
          <pre className="overflow-auto rounded bg-zinc-950 p-2.5 text-[11px] leading-relaxed text-red-300/80 ring-1 ring-zinc-800">
            {detail.stacktrace.join('\n')}
          </pre>
        </section>
      )}
    </div>
  );
}

/** Right slide-over showing a single job's full detail + actions. */
export function JobDetailDrawer({
  driver,
  queue,
  jobId,
  state,
  capabilities,
  onClose,
}: {
  driver: string;
  queue: string;
  jobId: string;
  state: QueueState;
  capabilities: QueueCapabilities | undefined;
  onClose: () => void;
}): JSX.Element {
  const { data, isLoading, isError } = useQueueJob(driver, queue, jobId);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close job detail"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <aside className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <span className="text-xs uppercase tracking-wide text-zinc-500">Job detail</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {isLoading ? (
            <p className="text-xs text-zinc-600">Loading job…</p>
          ) : isError ? (
            <p className="text-xs text-red-400">Failed to load job.</p>
          ) : !data ? (
            <p className="text-xs text-zinc-600">Job not found (it may have been removed).</p>
          ) : (
            <DetailBody
              detail={data}
              capabilities={capabilities}
              driver={driver}
              queue={queue}
              state={state}
              onClose={onClose}
            />
          )}
        </div>
      </aside>
    </div>
  );
}
