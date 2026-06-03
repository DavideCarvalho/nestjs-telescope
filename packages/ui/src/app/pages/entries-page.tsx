import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  EntriesTable,
  EntryInsights,
  dotForType,
  isKnownType,
  labelForType,
  resolveEntryQuery,
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
  const [searchParams] = useSearchParams();
  const [tag, setTag] = useState('');
  // `searchDraft` tracks the input; `search` is the submitted value that actually
  // drives the query, so typing never refetches — only Enter commits.
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');

  const activeType = routeType && isKnownType(routeType) ? routeType : undefined;
  const trimmedTag = tag.trim();
  const trimmedSearch = search.trim();
  const familyHash = searchParams.get('familyHash') ?? '';
  const hasFamilyHash = familyHash !== '';
  const hasSearch = trimmedSearch !== '';
  const hasFilters = activeType !== undefined || trimmedTag !== '' || hasFamilyHash || hasSearch;

  const { data, isLoading } = useEntries({
    ...(activeType ? resolveEntryQuery(activeType) : {}),
    ...(trimmedTag !== '' ? { tag: trimmedTag } : {}),
    ...(hasFamilyHash ? { familyHash } : {}),
    ...(hasSearch ? { search: trimmedSearch } : {}),
  });
  const entries = data?.data ?? [];

  function submitSearch(): void {
    setSearch(searchDraft);
  }

  function clearSearch(): void {
    setSearchDraft('');
    setSearch('');
  }

  function clearFilters(): void {
    setTag('');
    clearSearch();
    navigate('/entries');
  }

  function clearFamilyHash(): void {
    navigate(activeType ? `/entries/${activeType}` : '/entries');
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
        <input
          type="text"
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitSearch();
          }}
          onBlur={submitSearch}
          placeholder="Search content…"
          aria-label="Search content"
          className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
        />
        {hasSearch ? (
          <button
            type="button"
            onClick={clearSearch}
            className="flex items-center gap-1.5 rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            <span>{`search:"${trimmedSearch}"`}</span>
            <span className="text-zinc-500" aria-hidden="true">
              ×
            </span>
          </button>
        ) : null}
        {hasFamilyHash ? (
          <button
            type="button"
            onClick={clearFamilyHash}
            className="flex items-center gap-1.5 rounded bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-200 hover:bg-zinc-800"
          >
            <span className="text-zinc-500" aria-hidden="true">
              family:
            </span>
            {familyHash.slice(0, 12)}
            <span className="text-zinc-500" aria-hidden="true">
              ×
            </span>
          </button>
        ) : null}
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
