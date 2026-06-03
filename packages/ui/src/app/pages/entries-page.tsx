import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  EntriesTable,
  EntryInsights,
  dotForType,
  isKnownType,
  labelForType,
  useEntries,
} from '../../react/index.js';

function emptyMessage(type: string | undefined, tag: string): string {
  if (tag.trim() !== '') return `No entries match tag '${tag.trim()}'`;
  if (type) return `No ${labelForType(type)} entries`;
  return 'No entries';
}

export function EntriesPage(): JSX.Element {
  const { type: routeType } = useParams();
  const navigate = useNavigate();
  const [tag, setTag] = useState('');

  const activeType = routeType && isKnownType(routeType) ? routeType : undefined;
  const trimmedTag = tag.trim();
  const hasFilters = activeType !== undefined || trimmedTag !== '';

  const { data, isLoading } = useEntries({
    ...(activeType ? { type: activeType } : {}),
    ...(trimmedTag !== '' ? { tag: trimmedTag } : {}),
  });
  const entries = data?.data ?? [];

  function clearFilters(): void {
    setTag('');
    navigate('/entries');
  }

  return (
    <div className="p-4">
      {activeType ? <EntryInsights type={activeType} /> : null}
      <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-zinc-800 pb-3">
        {activeType ? (
          <button
            type="button"
            onClick={() => navigate('/entries')}
            className="flex items-center gap-1.5 rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            <span className={`h-2 w-2 rounded-full ${dotForType(activeType)}`} aria-hidden="true" />
            {labelForType(activeType)}
            <span className="text-zinc-500" aria-hidden="true">
              ×
            </span>
          </button>
        ) : (
          <span className="rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-400">All types</span>
        )}
        <input
          type="text"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          placeholder="Filter by tag…"
          aria-label="Filter by tag"
          className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
        />
        {hasFilters ? (
          <button
            type="button"
            onClick={clearFilters}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Clear filters
          </button>
        ) : null}
      </div>
      {isLoading ? (
        <p className="text-zinc-600">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-zinc-600">{emptyMessage(activeType, tag)}</p>
      ) : (
        <EntriesTable entries={entries} onSelect={(id) => navigate(`/entries/view/${id}`)} />
      )}
    </div>
  );
}
