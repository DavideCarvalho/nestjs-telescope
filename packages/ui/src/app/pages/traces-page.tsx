import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeftIcon, ChevronRightIcon } from '../../aviary-kit/icons';
import { Button } from '../../aviary-kit/ui/button';
import type { TraceSummary } from '../../client/index.js';
import { WindowSelect, dotForType, relativeTime, useTraces } from '../../react/index.js';
import { PageEmpty, RowsSkeleton, TelescopePage } from '../page-chrome.js';
import { useWindowParam } from '../url-state.js';
import { useAppLabels } from './trace-page.js';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function TraceRow({
  trace,
  showApps,
  appLabels,
}: {
  trace: TraceSummary;
  showApps: boolean;
  appLabels: Record<string, string>;
}): React.JSX.Element {
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
      {showApps ? (
        <span
          data-testid="trace-apps"
          className="hidden w-40 shrink-0 truncate text-xs text-fg-2 sm:inline"
          title={(trace.apps ?? []).join(' → ')}
        >
          {(trace.apps ?? []).map((id) => appLabels[id] ?? id).join(' → ')}
        </span>
      ) : null}
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

/**
 * Previous / Next over the cursor-paged traces list: the cursors of the pages walked so far are
 * kept, so Previous goes back to the page shown before (the server pages forward only).
 */
function TracesPager({
  page,
  hasNext,
  onPrevious,
  onNext,
}: {
  page: number;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}): React.JSX.Element | null {
  if (page === 1 && !hasNext) return null;
  return (
    <div className="flex items-center justify-end gap-2 px-1 py-2" data-testid="traces-pager">
      <Button
        variant="ghost"
        size="sm"
        aria-label="Newer traces"
        disabled={page === 1}
        onClick={onPrevious}
      >
        <ChevronLeftIcon />
        <span className="hidden sm:inline">Newer</span>
      </Button>
      <span className="mono tnum px-2 text-[11px] text-fg-2">page {page}</span>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Older traces"
        disabled={!hasNext}
        onClick={onNext}
      >
        <span className="hidden sm:inline">Older</span>
        <ChevronRightIcon />
      </Button>
    </div>
  );
}

export function TracesPage(): React.JSX.Element {
  const [window, setWindow] = useWindowParam();
  /** The `after` cursor of each page walked past the first, for the window they were walked in. */
  const [paging, setPaging] = useState<{ window: string; cursors: string[] }>({
    window,
    cursors: [],
  });
  // A new window (the picker, back/forward, an edited link) starts again at the first page.
  if (paging.window !== window) setPaging({ window, cursors: [] });
  const cursors = paging.window === window ? paging.cursors : [];
  const setCursors = (update: (previous: string[]) => string[]) =>
    setPaging((previous) => ({ window, cursors: update(previous.cursors) }));
  const after = cursors[cursors.length - 1];
  const { data, isLoading } = useTraces(window, undefined, after);
  const traces = data?.data ?? [];
  const appLabels = useAppLabels();
  // An Apps column once a trace in the window carries apps (a control plane).
  const showApps = traces.some((trace) => (trace.apps?.length ?? 0) > 0);

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
          description="Traces appear once a traceContext provider or `propagation` tags entries with a trace id."
        />
      ) : (
        <>
          <div className="aviary-surface overflow-hidden rounded-lg border border-border">
            {traces.map((trace) => (
              <TraceRow
                key={trace.traceId}
                trace={trace}
                showApps={showApps}
                appLabels={appLabels}
              />
            ))}
          </div>
          <TracesPager
            page={cursors.length + 1}
            hasNext={data?.hasNext === true && typeof data.nextCursor === 'string'}
            onPrevious={() => setCursors((walked) => walked.slice(0, -1))}
            onNext={() => {
              const next = data?.nextCursor;
              if (typeof next === 'string') setCursors((walked) => [...walked, next]);
            }}
          />
        </>
      )}
    </TelescopePage>
  );
}
