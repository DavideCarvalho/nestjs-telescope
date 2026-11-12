import { useEffect, useId, useRef, useState } from 'react';
import { useTenancy } from '../react/index.js';
import { Input } from '../react/ui/index.js';

const ALL = 'All organizations';

/** Shows another organization: the choice lives in the page URL (`?tenant=`), sent by every call. */
export function selectOrganization(id: string | null): void {
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete('tenant');
  else url.searchParams.set('tenant', id);
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

/**
 * The header's "Organization" control, shown when the console is scoped by organization: a fixed
 * chip for one organization, a searchable picker for several or all of them.
 */
export function OrganizationPicker(): JSX.Element | null {
  const current = useTenancy();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim(), 200);
  const listed = useTenancy(open ? debounced : '');
  const containerRef = useRef<HTMLDivElement>(null);
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
    id === null ? ALL : (info.options.find((o) => o.id === id)?.label ?? id);
  const chip = 'rounded border border-line px-2 py-1 text-xs';

  if (Array.isArray(info.tenants) && info.tenants.length <= 1) {
    return (
      <span className={chip} title="Organization">
        <span className="text-muted-foreground">Organization: </span>
        {info.tenants[0] !== undefined ? label(info.tenants[0]) : 'none'}
      </span>
    );
  }

  const options = listed.data?.enabled ? listed.data.options : info.options;
  const choices: { id: string | null; label: string }[] = [
    ...(info.tenants === '*' &&
    (debounced === '' || ALL.toLowerCase().includes(debounced.toLowerCase()))
      ? [{ id: null, label: ALL }]
      : []),
    ...options,
  ];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className={`${chip} hover:bg-panel-2`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-muted-foreground">Organization: </span>
        {label(info.selected)}
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded border border-line bg-popover p-1 shadow-lg">
          <Input
            type="text"
            value={search}
            autoFocus
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search organizations…"
            aria-label="Search organizations"
          />
          <div
            id={listboxId}
            // biome-ignore lint/a11y/useSemanticElements: a styled option list, ARIA listbox pattern
            role="listbox"
            aria-label="Organizations"
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
                onClick={() => selectOrganization(choice.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') selectOrganization(choice.id);
                }}
                className={`cursor-pointer truncate px-2 py-1 text-xs hover:bg-panel-2 ${
                  choice.id === info.selected ? 'text-brand' : 'text-foreground'
                }`}
              >
                {choice.label}
              </div>
            ))}
            {choices.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">No organization found.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** With organization scopes on and none granted: the console asks to choose one instead of data. */
export function useNoOrganization(): boolean {
  const info = useTenancy().data;
  return info?.enabled === true && Array.isArray(info.tenants) && info.tenants.length === 0;
}
