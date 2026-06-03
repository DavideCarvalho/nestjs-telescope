import { useNavigate, useParams } from 'react-router-dom';
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
