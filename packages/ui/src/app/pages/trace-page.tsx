import { useNavigate, useParams } from 'react-router-dom';
import { downloadJson } from '../../react/components/export-json.js';
import { EntriesTable, useEntries } from '../../react/index.js';

export function TracePage(): JSX.Element {
  const { traceId = '' } = useParams();
  const navigate = useNavigate();

  const { data, isLoading } = useEntries({ traceId });
  const entries = data?.data ?? [];

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
        {entries.length > 0 ? (
          <button
            type="button"
            onClick={() => downloadJson(`telescope-trace-${traceId}.json`, entries)}
            className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100"
          >
            Download JSON
          </button>
        ) : null}
      </div>
      {isLoading ? (
        <p className="text-zinc-600">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-zinc-600">No entries in this trace</p>
      ) : (
        <EntriesTable entries={entries} onSelect={(id) => navigate(`/entries/view/${id}`)} />
      )}
    </div>
  );
}
