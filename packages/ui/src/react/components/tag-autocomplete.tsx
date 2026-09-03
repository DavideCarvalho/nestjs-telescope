import { useEffect, useId, useRef, useState } from 'react';
import { Input } from '../ui/index.js';
import { useTagsInfinite } from '../use-telescope-queries.js';

/** How long typing settles before it becomes a request. Long enough that a word costs one query,
 *  short enough that the list feels attached to the keyboard. */
const SEARCH_DEBOUNCE_MS = 200;

/** How close to the bottom of the list a scroll gets before the next page is asked for. */
const LOAD_MORE_MARGIN_PX = 48;

interface TagAutocompleteProps {
  /** Applies the chosen tag as the active entries filter (same effect as the old input). */
  onSelect: (tag: string) => void;
  /**
   * Fixed prefix the search is locked to (e.g. `user:` for the User filter).
   * Both the `GET /tags` query and the suggestion ranking prepend it, and it's
   * stripped from what the user types and from each suggestion's display so the
   * control reads as ids, not raw tags. Defaults to `''` — the generic tag
   * filter unchanged.
   */
  prefix?: string;
  /** Placeholder for the input. Defaults to the generic tag prompt. */
  placeholder?: string;
  /** Accessible label for the input. Defaults to `Filter by tag`. */
  ariaLabel?: string;
}

/** Settles a value that changes on every keystroke into one that changes once typing stops. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * Tag filter rendered as an accessible combobox: it lists the tags that exist, most-used first, with
 * their entry counts. Selecting one applies it as the active `tag` filter; typing something the list
 * does not offer still applies as typed, which a bounded list has to allow.
 *
 * Focus alone opens it — an operator should not have to guess a first character to discover what is
 * there. Both the search and the paging happen on the SERVER: the list is bounded because tag
 * cardinality grows with the data, so the values worth searching for are routinely the ones the
 * bound cut, and a search over the fetched page could never find them.
 */
export function TagAutocomplete({
  onSelect,
  prefix = '',
  placeholder = 'Filter by tag…',
  ariaLabel = 'Filter by tag',
}: TagAutocompleteProps): JSX.Element {
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const trimmed = input.trim();
  // The full tag the user is narrowing to — `user:` + `42` etc. The input shows only the stripped
  // portion (the id), while the query works against the real, prefixed namespace so counts match.
  const fullQuery = `${prefix}${trimmed}`;
  const debouncedSearch = useDebounced(trimmed, SEARCH_DEBOUNCE_MS);
  const tags = useTagsInfinite(prefix, debouncedSearch);
  const suggestions = tags.data?.pages.flat() ?? [];
  const showList = open && suggestions.length > 0;

  const listRef = useRef<HTMLDivElement>(null);
  function onListScroll(): void {
    const el = listRef.current;
    if (!el || !tags.hasNextPage || tags.isFetchingNextPage) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_MORE_MARGIN_PX) {
      void tags.fetchNextPage();
    }
  }

  /** What we show in the row / input for a tag — the prefix stripped off. */
  function displayOf(tag: string): string {
    return prefix !== '' && tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
  }

  // Clamp the highlight whenever the suggestion set shrinks.
  useEffect(() => {
    setHighlight((current) => (current >= suggestions.length ? 0 : current));
  }, [suggestions.length]);

  // Close when focus/click leaves the combobox.
  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      const target = event.target;
      if (target instanceof Node && !containerRef.current?.contains(target)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  // `tag` is always the full, prefixed tag the filter applies; the input mirrors
  // the stripped display so a User filter never shows the `user:` plumbing.
  function choose(tag: string): void {
    onSelect(tag);
    setInput(displayOf(tag));
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!showList) {
      if (event.key === 'Enter' && trimmed !== '') choose(fullQuery);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((current) => (current + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((current) => (current - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const picked = suggestions[highlight];
      if (picked) choose(picked.tag);
      else if (trimmed !== '') choose(fullQuery);
    }
  }

  const activeId = showList ? `${listboxId}-option-${highlight}` : undefined;

  return (
    <div ref={containerRef} className="relative">
      <Input
        type="text"
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-autocomplete="list"
        {...(activeId ? { 'aria-activedescendant': activeId } : {})}
      />
      {showList ? (
        <div
          id={listboxId}
          // biome-ignore lint/a11y/useSemanticElements: a <select> can't render styled tag+count option rows; ARIA combobox listbox pattern
          role="listbox"
          aria-label="Tag suggestions"
          tabIndex={-1}
          ref={listRef}
          onScroll={onListScroll}
          className="absolute left-0 top-full z-10 mt-1 max-h-64 w-48 overflow-auto rounded border border-line bg-popover py-1 shadow-lg"
        >
          {suggestions.map((suggestion, index) => (
            <div
              key={suggestion.tag}
              id={`${listboxId}-option-${index}`}
              // biome-ignore lint/a11y/useSemanticElements: <option> can't host the styled tag+count layout; ARIA combobox option pattern
              role="option"
              tabIndex={-1}
              aria-selected={index === highlight}
              onMouseDown={(event) => {
                // mousedown (not click) so the input's blur doesn't close the list first
                event.preventDefault();
                choose(suggestion.tag);
              }}
              onMouseEnter={() => setHighlight(index)}
              className={`flex cursor-pointer items-center justify-between gap-3 px-2 py-1 text-xs ${
                index === highlight ? 'bg-panel-2 text-foreground' : 'text-foreground'
              }`}
            >
              <span className="truncate">{displayOf(suggestion.tag)}</span>
              <span className="shrink-0 text-muted-foreground">{suggestion.count}</span>
            </div>
          ))}
          {tags.isFetchingNextPage ? (
            <p className="px-2 py-1 text-[10px] text-muted-foreground">loading more…</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
