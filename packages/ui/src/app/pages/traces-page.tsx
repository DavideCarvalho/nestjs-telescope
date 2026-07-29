import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TraceSummary } from '../../client/index.js';
import { WindowSelect, dotForType, relativeTime, useTraces } from '../../react/index.js';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function TraceRow({ trace }: { trace: TraceSummary }): JSX.Element {
  const navigate = useNavigate();
  const label = trace.rootLabel ?? trace.traceId;
  return (
    <button
      type="button"
      onClick={() => navigate(`/traces/${trace.traceId}`)}
      className="flex w-full items-center gap-3 border-b border-line-soft px-3 py-2 text-left hover:bg-panel"
    >
      <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
        {trace.types.map((type) => (
          <span key={type} className={`h-2 w-2 rounded-full ${dotForType(type)}`} title={type} />
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={label}>
        {label}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {trace.entryCount} {trace.entryCount === 1 ? 'entry' : 'entries'}
      </span>
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
        {formatDuration(trace.totalDurationMs)}
      </span>
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
        {relativeTime(new Date(trace.lastAt).getTime())}
      </span>
    </button>
  );
}

export function TracesPage(): JSX.Element {
  const [window, setWindow] = useState('1h');
  const { data, isLoading } = useTraces(window);
  const traces = data?.traces ?? [];

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm text-brand">Traces</h2>
        <WindowSelect value={window} onChange={setWindow} />
      </div>
      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : traces.length === 0 ? (
        <p className="text-muted-foreground">No traces in this window</p>
      ) : (
        <div className="border border-line">
          {traces.map((trace) => (
            <TraceRow key={trace.traceId} trace={trace} />
          ))}
        </div>
      )}
    </div>
  );
}
