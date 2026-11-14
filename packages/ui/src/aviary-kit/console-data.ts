import { type ConsoleIconKey, consoleIconKey } from './icons';
import { type SearchConfig, type SwitcherConfig, isSafeHref } from './shell-config';

/**
 * The two requests the switcher and ⌘K make, with every entry sanitized (unsafe hrefs dropped,
 * unknown icons → `generic`). Any failure reads as "nothing": the shell never breaks on them.
 * aviary: an endpoint that answers 404/405/501 isn't served by this app (`routes: false` with the
 * host's own controllers): it is remembered for the page's life and never asked again.
 */

export interface SwitcherConsole {
  id: string;
  title: string;
  package?: string;
  icon: ConsoleIconKey;
  href: string;
}

export interface SearchHit {
  title: string;
  subtitle?: string;
  href: string;
}

export interface SearchGroup {
  id: string;
  title: string;
  icon: ConsoleIconKey;
  hits: SearchHit[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function sanitizeConsoles(value: unknown): SwitcherConsole[] {
  if (!Array.isArray(value)) return [];
  const out: SwitcherConsole[] = [];
  for (const item of value) {
    const c = record(item);
    if (!c || typeof c.id !== 'string' || typeof c.title !== 'string' || !isSafeHref(c.href)) {
      continue;
    }
    out.push({
      id: c.id,
      title: c.title,
      ...(typeof c.package === 'string' ? { package: c.package } : {}),
      icon: consoleIconKey(c.icon),
      href: c.href,
    });
  }
  return out;
}

/** Search answers come as `{ results: [...] }` (durable & co.) or `{ groups: [...] }` (authkit). */
export function sanitizeSearchGroups(body: unknown): SearchGroup[] {
  const b = record(body);
  const list = Array.isArray(b?.results) ? b.results : Array.isArray(b?.groups) ? b.groups : [];
  const groups: SearchGroup[] = [];
  for (const item of list as unknown[]) {
    const g = record(item);
    if (!g || typeof g.id !== 'string' || typeof g.title !== 'string' || !Array.isArray(g.hits)) {
      continue;
    }
    const hits: SearchHit[] = [];
    for (const raw of g.hits as unknown[]) {
      const h = record(raw);
      if (!h || typeof h.title !== 'string' || !isSafeHref(h.href)) continue;
      hits.push({
        title: h.title,
        ...(typeof h.subtitle === 'string' ? { subtitle: h.subtitle } : {}),
        href: h.href,
      });
    }
    if (hits.length > 0)
      groups.push({ id: g.id, title: g.title, icon: consoleIconKey(g.icon), hits });
  }
  return groups;
}

/** aviary: a non-2xx answer, with its status. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

/**
 * aviary: the statuses that mean "this app doesn't serve that route" rather than "it failed": a
 * host that mounts a console with `routes: false` and its own controllers may leave out
 * `/consoles` and `/consoles/search`.
 */
const NOT_SERVED = new Set([404, 405, 501]);

/** aviary: whether `error` is an answer that means the endpoint isn't served (404/405/501). */
export function isNotServed(error: unknown): boolean {
  return error instanceof HttpError && NOT_SERVED.has(error.status);
}

/** aviary: endpoints that answered 404/405/501 in this page's life; never asked again. */
const unserved = new Set<string>();
const unservedListeners = new Set<() => void>();

/** aviary: whether `endpoint` may be served (`false` once it answered 404/405/501). */
export function isEndpointServed(endpoint: string): boolean {
  return !unserved.has(endpoint);
}

/** aviary: runs `listener` whenever an endpoint turns out not to be served. */
export function subscribeEndpointServed(listener: () => void): () => void {
  unservedListeners.add(listener);
  return () => {
    unservedListeners.delete(listener);
  };
}

function markUnserved(endpoint: string): void {
  if (unserved.has(endpoint)) return;
  unserved.add(endpoint);
  for (const listener of unservedListeners) listener();
}

/** GET `url` (under `endpoint`); an endpoint known not to be served rejects without a request. */
async function getJson(endpoint: string, url: string, signal?: AbortSignal): Promise<unknown> {
  if (unserved.has(endpoint)) throw new HttpError(404);
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const error = new HttpError(res.status);
    if (isNotServed(error)) markUnserved(endpoint);
    throw error;
  }
  return res.json();
}

let cached: { endpoint: string; result: Promise<SwitcherConsole[]> } | undefined;

/**
 * The other consoles this viewer may open, fetched once per page life. Only a successful answer is
 * kept: a failed request resolves to `[]` and is forgotten, so the next call asks again. aviary: an
 * endpoint that isn't served (404/405/501) stays `[]` for the page's life, with no new request.
 */
export function loadConsoles(config: SwitcherConfig): Promise<SwitcherConsole[]> {
  if (cached?.endpoint === config.endpoint) return cached.result;
  const result = getJson(config.endpoint, config.endpoint)
    .then((body) => sanitizeConsoles(record(body)?.consoles))
    .catch((error: unknown): SwitcherConsole[] => {
      if (!isNotServed(error) && cached?.result === result) cached = undefined;
      return [];
    });
  cached = { endpoint: config.endpoint, result };
  return result;
}

/** Forget the cached console list and the endpoints found not served (tests). */
export function resetConsoleCache(): void {
  cached = undefined;
  unserved.clear();
  for (const listener of unservedListeners) listener();
}

/**
 * One query across every console the viewer may open. Rejects when the request fails (network,
 * non-2xx as an {@link HttpError}, abort), so a caller can tell "no hits" from "didn't answer". The server fans out to each
 * console and drops one that errors or times out, so a single request covers them all.
 */
export async function fetchSearchGroups(
  config: SearchConfig,
  q: string,
  signal?: AbortSignal,
): Promise<SearchGroup[]> {
  return sanitizeSearchGroups(
    await getJson(config.endpoint, `${config.endpoint}?q=${encodeURIComponent(q)}`, signal),
  );
}

/**
 * aviary: one console's hits (`?q=&console=<id>`). Rejects on failure like
 * {@link fetchSearchGroups}; keeps only that console's group, so a server that ignores `console`
 * still yields the right answer.
 */
export async function fetchConsoleGroups(
  config: SearchConfig,
  q: string,
  consoleId: string,
  signal?: AbortSignal,
): Promise<SearchGroup[]> {
  const url = `${config.endpoint}?q=${encodeURIComponent(q)}&console=${encodeURIComponent(consoleId)}`;
  return sanitizeSearchGroups(await getJson(config.endpoint, url, signal)).filter(
    (g) => g.id === consoleId,
  );
}

/**
 * aviary: the consoles ⌘K asks one by one, this one first, then the switcher's list. `undefined`
 * when the endpoint can't answer per console (no `self`), or when the switcher announced other
 * consoles but their list didn't load: the caller then makes one request for all of them.
 */
export async function searchTargets(
  config: SearchConfig,
  switcher: SwitcherConfig | undefined,
): Promise<string[] | undefined> {
  if (!config.self) return undefined;
  if (!switcher) return [config.self];
  const others = await loadConsoles(switcher);
  if (others.length === 0) return undefined;
  return [config.self, ...others.map((c) => c.id).filter((id) => id !== config.self)];
}

/** {@link fetchSearchGroups}, with any failure read as "nothing". */
export async function searchConsoles(
  config: SearchConfig,
  q: string,
  signal?: AbortSignal,
): Promise<SearchGroup[]> {
  try {
    return await fetchSearchGroups(config, q, signal);
  } catch {
    return [];
  }
}
