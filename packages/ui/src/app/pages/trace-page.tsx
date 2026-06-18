import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { downloadJson } from '../../react/components/export-json.js';
import { WaterfallView } from '../../react/components/waterfall-view.js';
import { EntriesTable, useEntries, useWaterfall } from '../../react/index.js';

type View = 'waterfall' | 'entries';

export function TracePage(): JSX.Element {
  const { traceId = '' } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState<View>('waterfall');

  const { data, isLoading } = useEntries({ traceId });
  const entries = data?.data ?? [];
  const { data: waterfall, isLoading: waterfallLoading } = useWaterfall(traceId);

  return (
    <div className="p-4">
      <button
        type="button"
        onClick={() => navigate('/entries')}
        className="mb-4 text-xs text-zinc-500 hover:text-zinc-300"
      >
        ← entries
      </button>
      <div className="mb-4 flex flex-wrap items-baseline gap-3 border-b border-zinc-800 pb-3">
        <h2 className="text-xs uppercase tracking-wide text-zinc-500">Trace</h2>
        <span className="max-w-md truncate font-mono text-xs text-zinc-300" title={traceId}>
          {traceId}
        </span>
        <span className="text-xs text-zinc-500">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex overflow-hidden rounded border border-zinc-700 text-[11px]">
            <button
              type="button"
              onClick={() => setView('waterfall')}
              className={`px-2.5 py-1 transition-colors ${
                view === 'waterfall'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Waterfall
            </button>
            <button
              type="button"
              onClick={() => setView('entries')}
              className={`border-l border-zinc-700 px-2.5 py-1 transition-colors ${
                view === 'entries'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Entries
            </button>
          </div>
          {entries.length > 0 ? (
            <button
              type="button"
              onClick={() => downloadJson(`telescope-trace-${traceId}.json`, entries)}
              className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100"
            >
              Download JSON
            </button>
          ) : null}
        </div>
      </div>
      {view === 'waterfall' ? (
        waterfallLoading ? (
          <p className="text-zinc-600">Loading…</p>
        ) : waterfall === undefined || waterfall.spans.length === 0 ? (
          <p className="text-zinc-600">No spans in this trace</p>
        ) : (
          <WaterfallView waterfall={waterfall} onSelect={(id) => navigate(`/entries/view/${id}`)} />
        )
      ) : isLoading ? (
        <p className="text-zinc-600">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-zinc-600">No entries in this trace</p>
      ) : (
        <EntriesTable entries={entries} onSelect={(id) => navigate(`/entries/view/${id}`)} />
      )}
    </div>
  );
}
