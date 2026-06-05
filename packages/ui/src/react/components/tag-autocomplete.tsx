import { useEffect, useId, useRef, useState } from 'react';
import type { TagCount } from '../../client/index.js';
import { useTags } from '../use-telescope-queries.js';

/** Top-N suggestions shown in the dropdown, sorted by count desc. */
const MAX_SUGGESTIONS = 10;

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

/** Sorts by count desc, caps to the top N, and (defensively) filters by the typed prefix
 *  in case a stale/over-broad cache entry is served while a narrower query loads. */
function rankSuggestions(tags: TagCount[], prefix: string): TagCount[] {
  const needle = prefix.trim().toLowerCase();
  return tags
    .filter((entry) => needle === '' || entry.tag.toLowerCase().includes(needle))
    .sort((left, right) => right.count - left.count)
    .slice(0, MAX_SUGGESTIONS);
}

/**
 * Tag filter rendered as an accessible combobox: typing queries `GET /tags?prefix=`
 * and surfaces matching tags with their entry counts. Selecting one applies it as the
 * active `tag` filter and closes the list. Empty input shows no dropdown.
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
  // The full tag the user is narrowing to — `user:` + `42` etc. The input shows
  // only the stripped portion (the id), but the query and ranking work against
  // the real, prefixed tag namespace so counts and matches stay correct.
  const fullQuery = `${prefix}${trimmed}`;
  const { data } = useTags(fullQuery);
  const suggestions = trimmed === '' ? [] : rankSuggestions(data ?? [], fullQuery);
  const showList = open && suggestions.length > 0;

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
      <input
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
        className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
      />
      {showList ? (
        <div
          id={listboxId}
          // biome-ignore lint/a11y/useSemanticElements: a <select> can't render styled tag+count option rows; ARIA combobox listbox pattern
          role="listbox"
          aria-label="Tag suggestions"
          tabIndex={-1}
          className="absolute left-0 top-full z-10 mt-1 max-h-64 w-48 overflow-auto rounded border border-zinc-800 bg-zinc-950 py-1 shadow-lg"
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
                index === highlight ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300'
              }`}
            >
              <span className="truncate">{displayOf(suggestion.tag)}</span>
              <span className="shrink-0 text-zinc-500">{suggestion.count}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
