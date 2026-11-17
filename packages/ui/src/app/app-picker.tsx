import { useEffect, useId, useRef, useState } from 'react';
import { useApps } from '../react/index.js';
import { Input } from '../react/ui/index.js';

const ALL = 'All apps';

/** Shows another app: the choice lives in the page URL (`?app=`), sent by every call. */
export function selectApp(id: string | null): void {
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete('app');
  else url.searchParams.set('app', id);
  window.location.assign(url.toString());
}

function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Moves focus between the options of a listbox with the arrow keys. */
function moveFocus(listbox: HTMLElement | null, step: 1 | -1): void {
  const options = [...(listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
  if (options.length === 0) return;
  const index = options.indexOf(document.activeElement as HTMLElement);
  const next = options[(index + step + options.length) % options.length];
  next?.focus();
}

/**
 * The header's "App" control, shown on a control plane that receives several apps' entries: a
 * fixed chip for a viewer limited to one app, a searchable picker otherwise. Hidden on a
 * standalone app (no entry carries an app).
 */
export function AppPicker(): React.JSX.Element | null {
  const current = useApps();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim(), 200);
  const listed = useApps(open ? debounced : '');
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      const target = event.target;
      if (target instanceof Node && !containerRef.current?.contains(target)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  const info = current.data;
  if (!info?.enabled) return null;
  const label = (id: string | null): string =>
    id === null ? ALL : (info.apps.find((a) => a.id === id)?.label ?? id);
  const chip = 'rounded border border-line px-2 py-1 text-xs';

  if (!info.all && info.apps.length <= 1) {
    return (
      <span className={chip} title="App">
        <span className="text-muted-foreground">App: </span>
        {info.apps[0]?.label ?? 'none'}
      </span>
    );
  }

  const apps = listed.data?.enabled ? listed.data.apps : info.apps;
  const choices: { id: string | null; label: string; federated?: true }[] = [
    ...(debounced === '' || ALL.toLowerCase().includes(debounced.toLowerCase())
      ? [{ id: null, label: ALL }]
      : []),
    ...apps,
  ];

  return (
    <div
      ref={containerRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        className={`${chip} hover:bg-panel-2`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-muted-foreground">App: </span>
        {label(info.selected)}
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded border border-line bg-popover p-1 shadow-lg">
          <Input
            type="text"
            value={search}
            autoFocus
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveFocus(listboxRef.current, 1);
              }
            }}
            placeholder="Search apps…"
            aria-label="Search apps"
          />
          <div
            ref={listboxRef}
            id={listboxId}
            // biome-ignore lint/a11y/useSemanticElements: a styled option list, ARIA listbox pattern
            role="listbox"
            aria-label="Apps"
            tabIndex={-1}
            className="mt-1 max-h-64 overflow-auto"
          >
            {choices.map((choice) => (
              <div
                key={choice.id ?? '*'}
                // biome-ignore lint/a11y/useSemanticElements: styled row, ARIA option pattern
                role="option"
                tabIndex={0}
                aria-selected={choice.id === info.selected}
                onClick={() => selectApp(choice.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') selectApp(choice.id);
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    moveFocus(listboxRef.current, event.key === 'ArrowDown' ? 1 : -1);
                  }
                }}
                className={`cursor-pointer truncate px-2 py-1 text-xs hover:bg-panel-2 focus:bg-panel-2 focus:outline-none ${
                  choice.id === info.selected ? 'text-brand' : 'text-foreground'
                }`}
              >
                {choice.label}
                {'federated' in choice && choice.federated ? (
                  <span className="ml-1 text-muted-foreground">· own store</span>
                ) : null}
              </div>
            ))}
            {choices.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">No app found.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
