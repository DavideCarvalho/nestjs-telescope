import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ENTRY_TYPES } from '../react/index.js';

/** A single navigable target in the palette. */
export interface PaletteAction {
  /** Stable id, used for the listbox option element id. */
  id: string;
  /** Human-facing label, matched against the query (case-insensitive). */
  label: string;
  /** Hash-router path to navigate to, e.g. `/` or `/entries/request`. */
  to: string;
}

/**
 * The static console/page targets. Kept as a literal list (vs. the dynamic
 * `ENTRY_TYPES` below) so adding a page is a one-line edit here. `Server` is
 * the queue metrics sub-route, which is the closest thing the UI ships to a
 * server/metrics console.
 */
const PAGE_ACTIONS: PaletteAction[] = [
  { id: 'page-overview', label: 'Overview', to: '/' },
  { id: 'page-entries', label: 'Entries', to: '/entries' },
  { id: 'page-pulse', label: 'Pulse', to: '/pulse' },
  { id: 'page-queues', label: 'Queues', to: '/queues' },
  { id: 'page-metrics', label: 'Queue Metrics', to: '/queues/metrics' },
  { id: 'page-schedules', label: 'Schedules', to: '/schedules' },
  { id: 'page-traces', label: 'Traces', to: '/traces' },
];

/**
 * The full action list: every entry-type watcher (derived from `ENTRY_TYPES`
 * so it stays in sync) plus the static pages. Built once at module load.
 */
export const PALETTE_ACTIONS: PaletteAction[] = [
  ...PAGE_ACTIONS,
  ...ENTRY_TYPES.map((type) => ({
    id: `entry-${type.id}`,
    label: type.label,
    to: `/entries/${type.id}`,
  })),
];

/** Case-insensitive substring filter over action labels. */
export function filterActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return actions;
  return actions.filter((action) => action.label.toLowerCase().includes(needle));
}

/**
 * Local open/close state for the palette plus the global Cmd+K / Ctrl+K key
 * handler. Self-contained so `dashboard-layout` only needs `usePalette()` +
 * `<CommandPalette>`.
 */
export function usePalette(): { open: boolean; setOpen: (open: boolean) => void } {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return { open, setOpen };
}

export function CommandPalette({
  open,
  onClose,
}: { open: boolean; onClose: () => void }): JSX.Element | null {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const listId = useId();

  const results = useMemo(() => filterActions(PALETTE_ACTIONS, query), [query]);

  // Reset the query/highlight and focus the input each time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlight(0);
    inputRef.current?.focus();
  }, [open]);

  // Keep the highlight within the (possibly shrinking) result list.
  useEffect(() => {
    setHighlight((prev) => (results.length === 0 ? 0 : Math.min(prev, results.length - 1)));
  }, [results.length]);

  const select = useCallback(
    (action: PaletteAction | undefined) => {
      if (!action) return;
      navigate(action.to);
      onClose();
    },
    [navigate, onClose],
  );

  if (!open) return null;

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((prev) => (prev + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((prev) => (prev - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      select(results[highlight]);
    }
  }

  const activeId = results[highlight] ? `${listId}-${results[highlight].id}` : undefined;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close is a pointer affordance; Escape handles keyboard close.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh]"
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a div with role=dialog is the portable modal pattern here; <dialog> needs imperative showModal wiring. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-lg overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Jump to…"
          aria-label="Search actions"
          aria-controls={listId}
          aria-activedescendant={activeId}
          className="w-full border-b border-zinc-800 bg-transparent px-4 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        {/* biome-ignore lint/a11y/useSemanticElements: ARIA listbox is the canonical combobox popup; <select>/<option> can't host this rich layout, and focus stays on the input via aria-activedescendant. */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: the listbox is not a tab stop; the input owns focus and drives it via aria-activedescendant. */}
        {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: listbox is the correct role for the combobox popup; activation happens on the input. */}
        <ul id={listId} role="listbox" className="max-h-72 overflow-y-auto py-1">
          {results.length === 0 ? (
            <li className="px-4 py-3 text-xs text-zinc-500">No matching actions</li>
          ) : (
            results.map((action, index) => {
              return (
                // biome-ignore lint/a11y/useFocusableInteractive: options are not tab stops; the input keeps focus and tracks the active option via aria-activedescendant.
                <li
                  key={action.id}
                  id={`${listId}-${action.id}`}
                  // biome-ignore lint/a11y/useSemanticElements: ARIA option inside the listbox combobox popup (see <ul> above).
                  // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: option is the correct role for a listbox child; activation is handled on the input (Enter).
                  role="option"
                  aria-selected={index === highlight}
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(event) => {
                    // mousedown (not click) so selection fires before the input blurs.
                    event.preventDefault();
                    select(action);
                  }}
                  className={`cursor-pointer px-4 py-2 text-sm ${
                    index === highlight ? 'bg-zinc-800 text-emerald-300' : 'text-zinc-300'
                  }`}
                >
                  {action.label}
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
