import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ConsoleIcon, type ConsoleIconKey, iconKey } from './console-switcher-icons.js';

/** The `switcher` field of the page's JSON config block. */
export interface SwitcherConfig {
  endpoint: string;
  others: number;
}

/** One other console the viewer may open. */
export interface SwitcherConsole {
  id: string;
  title: string;
  icon: ConsoleIconKey;
  href: string;
}

/** A same-origin absolute path: `/x`, never `//host`, a scheme, or anything else. */
export function isSafeHref(href: unknown): href is string {
  return typeof href === 'string' && href.startsWith('/') && !href.startsWith('//');
}

/** The `switcher` field of the config block `elementId`, or `undefined` when absent or unusable. */
export function readSwitcherConfig(elementId: string): SwitcherConfig | undefined {
  if (typeof document === 'undefined') return undefined;
  const element = document.getElementById(elementId);
  if (element === null) return undefined;
  try {
    const parsed = JSON.parse(element.textContent ?? '') as { switcher?: Partial<SwitcherConfig> };
    const switcher = parsed?.switcher;
    if (!switcher || !isSafeHref(switcher.endpoint)) return undefined;
    if (typeof switcher.others !== 'number' || switcher.others <= 0) return undefined;
    return { endpoint: switcher.endpoint, others: switcher.others };
  } catch {
    return undefined;
  }
}

/** The usable entries of a `consoles` list: unsafe `href`s dropped, unknown icons made generic. */
export function sanitizeConsoles(value: unknown): SwitcherConsole[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || typeof c.title !== 'string' || !isSafeHref(c.href)) return [];
    return [{ id: c.id, title: c.title, icon: iconKey(c.icon), href: c.href }];
  });
}

let cached: { endpoint: string; result: Promise<SwitcherConsole[]> } | undefined;

/** The consoles this viewer may open, fetched once per page. Any failure reads as "none". */
export function loadConsoles(config: SwitcherConfig): Promise<SwitcherConsole[]> {
  if (cached?.endpoint === config.endpoint) return cached.result;
  const result = fetch(config.endpoint, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  })
    .then(async (res) =>
      res.ok ? sanitizeConsoles(((await res.json()) as { consoles?: unknown })?.consoles) : [],
    )
    .catch(() => []);
  cached = { endpoint: config.endpoint, result };
  return result;
}

/** One hit of the global search, from any console the viewer may open. */
export interface ConsoleSearchHit {
  title: string;
  subtitle?: string;
  href: string;
}

/** One console's hits. */
export interface ConsoleSearchGroup {
  id: string;
  title: string;
  icon: ConsoleIconKey;
  hits: ConsoleSearchHit[];
}

/** The global search's answer: the groups, and whether a console's part is missing (`partial`). */
export interface ConsoleSearchAnswer {
  groups: ConsoleSearchGroup[];
  partial: boolean;
}

/** The usable groups of a `consoles/search` answer: unsafe `href`s dropped, unknown icons made generic. */
export function sanitizeSearch(value: unknown): ConsoleSearchAnswer {
  const body = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const groups = (Array.isArray(body.results) ? body.results : []).flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const g = item as Record<string, unknown>;
    if (typeof g.id !== 'string' || typeof g.title !== 'string' || !Array.isArray(g.hits))
      return [];
    const hits = g.hits.flatMap((hit: unknown) => {
      if (typeof hit !== 'object' || hit === null) return [];
      const h = hit as Record<string, unknown>;
      if (typeof h.title !== 'string' || !isSafeHref(h.href)) return [];
      return [
        {
          title: h.title,
          ...(typeof h.subtitle === 'string' ? { subtitle: h.subtitle } : {}),
          href: h.href,
        },
      ];
    });
    return hits.length > 0 ? [{ id: g.id, title: g.title, icon: iconKey(g.icon), hits }] : [];
  });
  return { groups, partial: body.partial === true };
}

/** `GET <consoles endpoint>/search?q=`. Any failure reads as "no hits". */
export async function searchConsoles(
  endpoint: string,
  q: string,
  signal?: AbortSignal,
): Promise<ConsoleSearchAnswer> {
  try {
    const res = await fetch(`${endpoint}/search?q=${encodeURIComponent(q)}`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    return res.ok ? sanitizeSearch(await res.json()) : { groups: [], partial: false };
  } catch {
    return { groups: [], partial: false };
  }
}

/** Forget the fetched list (tests). */
export function resetSwitcherCache(): void {
  cached = undefined;
}

/**
 * The console brand, turned into a menu of the other Aviary consoles this viewer may open. With no
 * config (this console is alone) or an empty list it renders the plain brand and makes no request
 * (or, with a config, exactly one, after first paint).
 */
export function ConsoleSwitcher({
  brand,
  current,
  config,
  onSearch,
}: {
  brand: ReactNode;
  current: { title: string; icon: ConsoleIconKey };
  config: SwitcherConfig | undefined;
  /** Opens the global search (the command palette); adds a "Search all consoles" item. */
  onSearch?: () => void;
}) {
  const [consoles, setConsoles] = useState<SwitcherConsole[]>([]);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!config) return;
    let live = true;
    void loadConsoles(config).then((list) => {
      if (live) setConsoles(list);
    });
    return () => {
      live = false;
    };
  }, [config]);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  const items = () =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const focusItem = (index: number) => {
    const list = items();
    if (list.length > 0) list[(index + list.length) % list.length]?.focus();
  };

  // Opening the menu focuses its first item.
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  if (!config || consoles.length === 0) return <>{brand}</>;

  const onMenuKey = (event: ReactKeyboardEvent) => {
    const at = items().indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, () => void> = {
      ArrowDown: () => focusItem(at + 1),
      ArrowUp: () => focusItem(at - 1),
      Home: () => focusItem(0),
      End: () => focusItem(-1),
      Escape: () => close(true),
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      move();
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  const item =
    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground outline-none focus:bg-line-soft';
  return (
    <div ref={root} className="relative" data-aviary-switcher="">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${current.title}: switch console`}
        className="flex items-center gap-1.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {brand}
        <svg
          viewBox="0 0 24 24"
          width={12}
          height={12}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className="text-muted-foreground"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="Consoles"
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className="absolute left-0 top-full z-50 mt-2 w-52 rounded-lg border border-line bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <div
            role="menuitem"
            aria-current="page"
            aria-disabled="true"
            tabIndex={-1}
            className={item}
          >
            <ConsoleIcon icon={current.icon} className="text-brand" />
            <span className="truncate">{current.title}</span>
            <svg
              viewBox="0 0 24 24"
              width={14}
              height={14}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="ml-auto text-brand"
              aria-hidden="true"
            >
              <path d="m5 12 5 5 9-10" />
            </svg>
          </div>
          {onSearch && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`${item} w-full hover:bg-line-soft`}
              onClick={() => {
                close(false);
                onSearch();
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width={16}
                height={16}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                className="text-muted-foreground"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <span className="truncate">Search all consoles</span>
              <kbd className="ml-auto text-[10px] text-muted-foreground">⌘K</kbd>
            </button>
          )}
          {consoles.map((c) => (
            <a
              key={c.id}
              role="menuitem"
              href={c.href}
              tabIndex={-1}
              className={`${item} hover:bg-line-soft`}
            >
              <ConsoleIcon icon={c.icon} className="text-muted-foreground" />
              <span className="truncate">{c.title}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
