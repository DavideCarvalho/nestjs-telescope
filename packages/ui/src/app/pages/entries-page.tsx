import { useQueryStates } from 'nuqs';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader, Toolbar } from '../../aviary-kit/blocks/page-header';
import { PageBody } from '../../aviary-kit/shell/app-shell';
import { readHashSearch } from '../../aviary-kit/url-state/hash-url';
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
import { PageEmpty, RowsSkeleton } from '../page-chrome.js';
import { textParam } from '../url-state.js';

/**
 * The entries filters in the URL: `?tag=` (a tag, or `user:<id>` for the User control),
 * `?q=` (the submitted content search) and `?familyHash=` (a query family, from Pulse's N+1
 * hotspots). The type is the route path (`#/entries/query`).
 */
const ENTRY_FILTERS = { tag: textParam, q: textParam, familyHash: textParam };

function emptyMessage(type: string | undefined, tag: string): string {
  if (tag.trim() !== '') return `No entries match tag '${tag.trim()}'`;
  if (type) return `No ${labelForType(type)} entries`;
  return 'No entries';
}

export function EntriesPage(): React.JSX.Element {
  const { type: routeType } = useParams();
  const navigate = useNavigate();
  // `?tag=` is also how a deep link (e.g. the "View all activity for this user" pivot) lands
  // pre-filtered. Picking or clearing a filter adds a history entry; committing a search rewrites
  // the current one.
  const [{ tag, q: search, familyHash }, setFilters] = useQueryStates(ENTRY_FILTERS);
  const setTag = (next: string) => void setFilters({ tag: next }, { history: 'push' });
  const setSearch = (next: string) => void setFilters({ q: next.trim() });
  // `searchDraft` tracks the input; `?q=` is the submitted value that actually drives the query,
  // so typing never refetches — only Enter (or leaving the box) commits. The draft follows the URL
  // when Back/Forward or a link changes `?q=`.
  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => setSearchDraft(search), [search]);
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
    setSearchDraft('');
    // A new route path drops the whole query (tag, search, family).
    navigate('/entries');
  }

  function clearFamilyHash(): void {
    void setFilters({ familyHash: null }, { history: 'push' });
  }

  return (
    <PageBody>
      <PageHeader
        title={activeType ? labelForType(activeType) : 'Entries'}
        description={
          activeType
            ? 'Recorded entries of this type, newest first, with their insights.'
            : 'Everything the watchers recorded, newest first. Filter by type, tag, user or content.'
        }
      />
      {activeType ? <EntryInsights type={activeType} /> : null}
      <Toolbar label="Entry filters" className="gap-2">
        {activeType ? (
          <Button
            variant="ghost"
            onClick={() => navigate({ pathname: '/entries', search: readHashSearch().toString() })}
            className="bg-panel text-foreground hover:bg-panel-2"
          >
            <span className={`h-2 w-2 rounded-full ${dotForType(activeType)}`} aria-hidden="true" />
            {labelForType(activeType)}
            <span className="text-muted-foreground" aria-hidden="true">
              ×
            </span>
          </Button>
        ) : (
          <span className="rounded-md border border-border bg-panel-2 px-2 py-1 text-xs text-dim">
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
      </Toolbar>
      {data?.partial ? (
        <output className="tint-warn block rounded-lg border px-4 py-3 text-sm">
          Older entries are unavailable right now — the store could only read part of its data, so
          this list may be missing them.
        </output>
      ) : null}
      {isLoading ? (
        <RowsSkeleton rows={10} />
      ) : entries.length === 0 ? (
        <PageEmpty
          title={emptyMessage(activeType, tag)}
          description="New entries show up here as the watchers record them."
        />
      ) : (
        <div className="aviary-surface overflow-hidden rounded-lg border border-border">
          <EntriesTable entries={entries} onSelect={(id) => navigate(`/entries/view/${id}`)} />
        </div>
      )}
    </PageBody>
  );
}
