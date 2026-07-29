import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  EntriesTable,
  EntryInsights,
  TagAutocomplete,
  USER_TAG_FILTER_PREFIX,
  dotForType,
  isKnownType,
  isUserTag,
  labelForType,
  resolveEntryQuery,
  useEntries,
  userTagId,
} from '../../react/index.js';
import { Button, Input } from '../../react/ui/index.js';

function emptyMessage(type: string | undefined, tag: string): string {
  if (tag.trim() !== '') return `No entries match tag '${tag.trim()}'`;
  if (type) return `No ${labelForType(type)} entries`;
  return 'No entries';
}

export function EntriesPage(): JSX.Element {
  const { type: routeType } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Seed the tag filter from `?tag=` so a deep link (e.g. the "View all activity
  // for this user" pivot) lands pre-filtered — same approach as `?familyHash=`.
  const [tag, setTag] = useState(() => searchParams.get('tag') ?? '');
  // `searchDraft` tracks the input; `search` is the submitted value that actually
  // drives the query, so typing never refetches — only Enter commits.
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  // Both comboboxes drive the single `tag` filter but each keeps its own draft
  // input. Bumping the opposite control's key remounts it, clearing the stale
  // text it left behind when a selection lands in the other one.
  const [genericTagKey, setGenericTagKey] = useState(0);
  const [userTagKey, setUserTagKey] = useState(0);

  function selectGenericTag(nextTag: string): void {
    setTag(nextTag);
    setUserTagKey((current) => current + 1);
  }

  function selectUserTag(nextTag: string): void {
    setTag(nextTag);
    setGenericTagKey((current) => current + 1);
  }

  const activeType = routeType && isKnownType(routeType) ? routeType : undefined;
  const trimmedTag = tag.trim();
  // The single active tag filter is rendered in one of two controls: a populated
  // `user:<id>` tag (whether selected in the User control or arriving via a
  // `?tag=user:x` pivot link from the entries table) shows as a User chip;
  // anything else shows as the generic tag chip. This is what makes the User
  // control RECOGNIZE a user pivot instead of leaking the raw `user:` tag.
  const activeUserTag = isUserTag(trimmedTag) ? trimmedTag : '';
  const activeGenericTag = activeUserTag === '' ? trimmedTag : '';
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
      <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-line pb-3">
        {activeType ? (
          <Button
            variant="ghost"
            onClick={() => navigate('/entries')}
            className="bg-panel text-foreground hover:bg-panel-2"
          >
            <span className={`h-2 w-2 rounded-full ${dotForType(activeType)}`} aria-hidden="true" />
            {labelForType(activeType)}
            <span className="text-muted-foreground" aria-hidden="true">
              ×
            </span>
          </Button>
        ) : (
          <span className="rounded bg-panel px-2 py-1 text-xs text-muted-foreground">
            All types
          </span>
        )}
        <TagAutocomplete key={`tag-${genericTagKey}`} onSelect={selectGenericTag} />
        <TagAutocomplete
          key={`user-${userTagKey}`}
          prefix={USER_TAG_FILTER_PREFIX}
          placeholder="Filter by user…"
          ariaLabel="Filter by user"
          onSelect={selectUserTag}
        />
        {activeGenericTag !== '' ? (
          <Button
            variant="ghost"
            onClick={() => setTag('')}
            className="bg-panel text-foreground hover:bg-panel-2"
          >
            <span>{`tag:${activeGenericTag}`}</span>
            <span className="text-muted-foreground" aria-hidden="true">
              ×
            </span>
          </Button>
        ) : null}
        {activeUserTag !== '' ? (
          <Button
            variant="ghost"
            onClick={() => setTag('')}
            className="bg-panel text-foreground hover:bg-panel-2"
          >
            <span>{`User: ${userTagId(activeUserTag)}`}</span>
            <span className="text-muted-foreground" aria-hidden="true">
              ×
            </span>
          </Button>
        ) : null}
        <Input
          type="text"
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submitSearch();
          }}
          onBlur={submitSearch}
          placeholder="Search content…"
          aria-label="Search content"
        />
        {hasSearch ? (
          <Button
            variant="ghost"
            onClick={clearSearch}
            className="bg-panel text-foreground hover:bg-panel-2"
          >
            <span>{`search:"${trimmedSearch}"`}</span>
            <span className="text-muted-foreground" aria-hidden="true">
              ×
            </span>
          </Button>
        ) : null}
        {hasFamilyHash ? (
          <Button
            variant="ghost"
            onClick={clearFamilyHash}
            className="bg-panel text-foreground hover:bg-panel-2"
          >
            <span className="text-muted-foreground" aria-hidden="true">
              family:
            </span>
            {familyHash.slice(0, 12)}
            <span className="text-muted-foreground" aria-hidden="true">
              ×
            </span>
          </Button>
        ) : null}
        {hasFilters ? (
          <Button variant="ghost" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>
      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-muted-foreground">{emptyMessage(activeType, tag)}</p>
      ) : (
        <EntriesTable entries={entries} onSelect={(id) => navigate(`/entries/view/${id}`)} />
      )}
    </div>
  );
}
