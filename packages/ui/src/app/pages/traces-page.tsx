import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TraceSummary } from '../../client/index.js';
import { WindowSelect, dotForType, relativeTime, useTraces } from '../../react/index.js';
import { PageEmpty, RowsSkeleton, TelescopePage } from '../page-chrome.js';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function TraceRow({ trace }: { trace: TraceSummary }): React.JSX.Element {
  const navigate = useNavigate();
  const label = trace.rootLabel ?? trace.traceId;
  return (
    <button
      type="button"
      onClick={() => navigate(`/traces/${trace.traceId}`)}
      className="flex w-full items-center gap-3 border-b border-line-soft px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-hover"
    >
      <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
        {trace.types.map((type) => (
          <span key={type} className={`h-2 w-2 rounded-full ${dotForType(type)}`} title={type} />
        ))}
      </span>
      <span className="mono min-w-0 flex-1 truncate text-xs text-fg" title={label}>
        {label}
      </span>
      <span className="hidden shrink-0 text-xs text-dim sm:inline">
        {trace.entryCount} {trace.entryCount === 1 ? 'entry' : 'entries'}
      </span>
      <span className="mono tnum w-16 shrink-0 text-right text-xs text-fg-2">
        {formatDuration(trace.totalDurationMs)}
      </span>
      <span className="mono tnum w-16 shrink-0 text-right text-xs text-faint">
        {relativeTime(new Date(trace.lastAt).getTime())}
      </span>
    </button>
  );
}

export function TracesPage(): React.JSX.Element {
  const [window, setWindow] = useState('1h');
  const { data, isLoading } = useTraces(window);
  const traces = data?.data ?? [];

  return (
    <TelescopePage
      title="Traces"
      description="Every request, job and span that shared a trace id, newest first."
      actions={<WindowSelect value={window} onChange={setWindow} />}
    >
      {isLoading ? (
        <RowsSkeleton />
      ) : traces.length === 0 ? (
        <PageEmpty
          title="No traces in this window"
          description="Traces appear once a traceContext provider tags entries with a trace id."
        />
      ) : (
        <div className="aviary-surface overflow-hidden rounded-lg border border-border">
          {traces.map((trace) => (
            <TraceRow key={trace.traceId} trace={trace} />
          ))}
        </div>
      )}
    </TelescopePage>
  );
}
