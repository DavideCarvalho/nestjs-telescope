// packages/core/src/nest/console-switcher.ts
import {
  Controller,
  type ExecutionContext,
  Get,
  Header,
  Query,
  createParamDecorator,
} from '@nestjs/common';

// ── the console registry (v1), re-declared: no Aviary console imports another ──────────────

/** The process-wide slot every Aviary console registers into (created by whichever boots first). */
export const AVIARY_CONSOLES_SLOT = Symbol.for('@dudousxd/aviary:consoles');

/** The icon a console shows in the switcher. An unknown value renders as `generic`. */
export type AviaryConsoleIcon =
  | 'workflow'
  | 'telescope'
  | 'media'
  | 'payments'
  | 'agent'
  | 'identity'
  | 'generic';

/** What a console's `authorize` answers; only `allowed: true` lists it. */
export interface AviaryConsoleDecision {
  allowed: boolean;
  reason?: string;
  redirectTo?: string;
}

/** One hit of a console's global search. */
export interface AviaryConsoleSearchHit {
  title: string;
  subtitle?: string;
  /** Same-origin absolute path (`/telescope#/entries/view/42`). */
  href: string;
}

/** One console the switcher can list. */
export interface AviaryConsoleEntry {
  /** `/^[a-z][a-z0-9-]*$/`: `'durable'`, `'telescope'`, `'agent'`, `'media'`, … */
  id: string;
  /** Product title: `'Workflows'`, `'Telescope'`, `'Agents'`, `'Media'`. */
  title: string;
  icon: AviaryConsoleIcon;
  /** Same-origin absolute path of the console's page (`/telescope`). */
  path: string;
  /** Sort key: durable 10, telescope 20, agent 30, media 50. */
  order: number;
  /** The console's resolved gate (what its own routes run). Never throws. */
  authorize(context: ExecutionContext): Promise<AviaryConsoleDecision>;
  /**
   * Global search over this console's data, for a viewer this console already allowed, at most
   * `limit` hits. Applies the console's own tenancy scope.
   */
  search?(context: ExecutionContext, q: string, limit: number): Promise<AviaryConsoleSearchHit[]>;
}

/** The value at {@link AVIARY_CONSOLES_SLOT}. Data only, so every console's copy is identical. */
export interface AviaryConsoleRegistry {
  readonly version: 1;
  readonly entries: AviaryConsoleEntry[];
}

/** One console as `GET <api>/consoles` returns it. */
export interface VisibleConsole {
  id: string;
  title: string;
  icon: AviaryConsoleIcon;
  href: string;
}

/** The answer of `GET <api>/consoles`. */
export interface VisibleConsoles {
  version: 1;
  current: string;
  consoles: VisibleConsole[];
}

/** The answer of `GET <api>/consoles/search?q=`. */
export interface ConsoleSearchResults {
  version: 1;
  q: string;
  /** `true` when a console's `authorize` or `search` failed or ran out of time: its hits are missing. */
  partial: boolean;
  results: Array<{
    id: string;
    title: string;
    icon: AviaryConsoleIcon;
    hits: AviaryConsoleSearchHit[];
  }>;
}

/** The `switcher` field of the shell's config block. */
export interface ConsoleSwitcherConfig {
  endpoint: string;
  others: number;
}

const ID = /^[a-z][a-z0-9-]*$/;
const ICONS = new Set<string>([
  'workflow',
  'telescope',
  'media',
  'payments',
  'agent',
  'identity',
  'generic',
]);

/** How long another console's `authorize` (or `search`) may take before it is left out. */
export const CONSOLE_PROBE_TIMEOUT_MS = 300;
/** Hits per console in a global search. */
export const CONSOLE_SEARCH_HITS = 5;
/** Longest query a global search passes on. */
const MAX_QUERY = 200;

/**
 * The probe marker: while the switcher runs other consoles' `authorize` (and `search`), the HTTP
 * request carries `aviaryProbe: true`. The switcher only asks, it opens nothing, so an `authorize`
 * that writes an audit trail can skip it with {@link isConsoleProbe}.
 */
export interface AviaryProbeMarked {
  aviaryProbe?: boolean;
}

function requestOf(context: ExecutionContext): (object & AviaryProbeMarked) | undefined {
  if (typeof context?.getType !== 'function' || context.getType() !== 'http') return undefined;
  const request = context.switchToHttp().getRequest<unknown>();
  return typeof request === 'object' && request !== null ? request : undefined;
}

/** Whether this call is the switcher probing (`request.aviaryProbe === true`). */
export function isConsoleProbe(context: ExecutionContext): boolean {
  return requestOf(context)?.aviaryProbe === true;
}

/** Runs `fn` with the probe marker on the request, restoring what was there before. */
async function probing<T>(context: ExecutionContext, fn: () => Promise<T>): Promise<T> {
  const request = requestOf(context);
  if (request === undefined) return fn();
  const previous = request.aviaryProbe;
  request.aviaryProbe = true;
  try {
    return await fn();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(request, 'aviaryProbe');
    else request.aviaryProbe = previous;
  }
}

const TIMED_OUT: unique symbol = Symbol('timed out');

/** `work`, or {@link TIMED_OUT} when it rejects or takes longer than `ms`. */
async function within<T>(work: () => Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .catch((): typeof TIMED_OUT => TIMED_OUT),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sorted(entries: readonly AviaryConsoleEntry[]): AviaryConsoleEntry[] {
  return [...entries].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function iconOf(icon: unknown): AviaryConsoleIcon {
  return ICONS.has(icon as string) ? (icon as AviaryConsoleIcon) : 'generic';
}

/** Each entry's verdict: allowed, denied, or unknown (its `authorize` failed or timed out). */
async function verdicts(
  entries: AviaryConsoleEntry[],
  context: ExecutionContext,
  ms: number,
): Promise<Array<boolean | undefined>> {
  const answers = await probing(context, () =>
    Promise.all(entries.map((entry) => within(() => entry.authorize(context), ms))),
  );
  return answers.map((answer) => (answer === TIMED_OUT ? undefined : answer?.allowed === true));
}

/** Whether `path` is a same-origin absolute path (`/x`; never `//host` or a URL). */
export function isSameOriginPath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');
}

/** The registry, when one is set with a version this copy reads. */
export function readAviaryConsoles(): AviaryConsoleRegistry | undefined {
  const value = (globalThis as Record<symbol, unknown>)[AVIARY_CONSOLES_SLOT] as
    | Partial<AviaryConsoleRegistry>
    | undefined;
  if (value?.version !== 1 || !Array.isArray(value.entries)) return undefined;
  return value as AviaryConsoleRegistry;
}

/**
 * Adds a console to the process's switcher registry, creating it when absent. Returns a function
 * that removes the entry again, or `undefined` when it was not added (another registry version, or
 * the id is taken: logged as a warning). A bad `id` or `path` throws.
 */
export function registerAviaryConsole(
  entry: AviaryConsoleEntry,
  logger?: { warn(message: string): void },
): (() => void) | undefined {
  if (!ID.test(entry.id)) throw new Error(`console id ${JSON.stringify(entry.id)} is invalid`);
  if (!isSameOriginPath(entry.path)) {
    throw new Error(`console path ${JSON.stringify(entry.path)} must start with a single "/"`);
  }
  const holder = globalThis as Record<symbol, unknown>;
  if (holder[AVIARY_CONSOLES_SLOT] === undefined) {
    const fresh: AviaryConsoleRegistry = { version: 1, entries: [] };
    holder[AVIARY_CONSOLES_SLOT] = fresh;
  }
  const registry = readAviaryConsoles();
  if (registry === undefined) return undefined;
  if (registry.entries.some((existing) => existing.id === entry.id)) {
    logger?.warn(`console id "${entry.id}" is already registered`);
    return undefined;
  }
  registry.entries.push(entry);
  return () => {
    const index = registry.entries.indexOf(entry);
    if (index !== -1) registry.entries.splice(index, 1);
  };
}

/** The shell's `switcher` config: only when another console is registered (no `authorize` runs). */
export function consoleSwitcherConfig(
  selfId: string,
  endpoint: string,
): ConsoleSwitcherConfig | undefined {
  const registry = readAviaryConsoles();
  if (!registry?.entries.some((entry) => entry.id === selfId)) return undefined;
  const others = registry.entries.filter((entry) => entry.id !== selfId).length;
  return others > 0 ? { endpoint, others } : undefined;
}

/**
 * The consoles other than `selfId` the viewer may open, by `order` then `id`. Every other entry's
 * `authorize` runs in parallel with the probe marker set, each given `timeoutMs`; a timeout, a
 * rejection or any denial hides it. No reason is ever returned.
 */
export async function listVisibleConsoles(
  registry: AviaryConsoleRegistry | undefined,
  selfId: string,
  context: ExecutionContext,
  timeoutMs = CONSOLE_PROBE_TIMEOUT_MS,
): Promise<VisibleConsoles> {
  const others = sorted(
    (registry?.entries ?? []).filter(
      (entry) => entry.id !== selfId && isSameOriginPath(entry.path),
    ),
  );
  const allowed = await verdicts(others, context, timeoutMs);
  return {
    version: 1,
    current: selfId,
    consoles: others
      .filter((_, index) => allowed[index] === true)
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        icon: iconOf(entry.icon),
        href: entry.path,
      })),
  };
}

/**
 * Global search: `q` goes to every console the viewer may open that has a `search` (this one
 * included: the viewer is already in it), in parallel with the probe marker set,
 * `timeoutMs` each, at most {@link CONSOLE_SEARCH_HITS} same-origin hits per console. Consoles with
 * no hit are left out; one whose `authorize` or `search` failed or timed out makes the answer
 * `partial`.
 */
export async function searchVisibleConsoles(
  registry: AviaryConsoleRegistry | undefined,
  selfId: string,
  context: ExecutionContext,
  q: string,
  timeoutMs = CONSOLE_PROBE_TIMEOUT_MS,
): Promise<ConsoleSearchResults> {
  const query = q.trim().slice(0, MAX_QUERY);
  if (registry === undefined || query === '') {
    return { version: 1, q: query, partial: false, results: [] };
  }
  const searchable = sorted(
    registry.entries.filter(
      (entry) => typeof entry.search === 'function' && isSameOriginPath(entry.path),
    ),
  );
  const others = searchable.filter((entry) => entry.id !== selfId);
  const allowed = await verdicts(others, context, timeoutMs);
  let partial = allowed.some((verdict) => verdict === undefined);
  const targets = sorted([
    ...searchable.filter((entry) => entry.id === selfId),
    ...others.filter((_, index) => allowed[index] === true),
  ]);
  const answers = await probing(context, () =>
    Promise.all(
      targets.map((entry) =>
        within(
          async () => (await entry.search?.(context, query, CONSOLE_SEARCH_HITS)) ?? [],
          timeoutMs,
        ),
      ),
    ),
  );
  const results: ConsoleSearchResults['results'] = [];
  targets.forEach((entry, index) => {
    const answer = answers[index];
    if (answer === TIMED_OUT || !Array.isArray(answer)) {
      partial = true;
      return;
    }
    const hits = answer
      .filter(
        (hit): hit is AviaryConsoleSearchHit =>
          typeof hit === 'object' &&
          hit !== null &&
          typeof hit.title === 'string' &&
          isSameOriginPath(hit.href),
      )
      .slice(0, CONSOLE_SEARCH_HITS)
      .map((hit) => ({
        title: hit.title,
        ...(typeof hit.subtitle === 'string' ? { subtitle: hit.subtitle } : {}),
        href: hit.href,
      }));
    if (hits.length > 0) {
      results.push({ id: entry.id, title: entry.title, icon: iconOf(entry.icon), hits });
    }
  });
  return { version: 1, q: query, partial, results };
}

// ── the telescope console's side ─────────────────────────────────────────────

/** The telescope console's id in the registry. */
export const TELESCOPE_CONSOLE_ID = 'telescope';

/** What the route hands on to the other consoles' `authorize`: this request's `ExecutionContext`. */
interface CurrentContext {
  context: ExecutionContext;
}

const CurrentExecutionContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentContext => ({ context }),
);

/**
 * `GET <path>/api/consoles`: the other Aviary consoles this viewer may open. Mounted with the API,
 * behind the console's `authorize`, so only someone who may open this console learns the list.
 */
@Controller()
export class TelescopeConsolesController {
  @Get('consoles')
  @Header('Cache-Control', 'private, no-store')
  consoles(@CurrentExecutionContext() current: CurrentContext): Promise<VisibleConsoles> {
    return listVisibleConsoles(readAviaryConsoles(), TELESCOPE_CONSOLE_ID, current.context);
  }

  /** `GET <path>/api/consoles/search?q=`: global search across the consoles this viewer may open. */
  @Get('consoles/search')
  @Header('Cache-Control', 'private, no-store')
  search(
    @CurrentExecutionContext() current: CurrentContext,
    @Query('q') q?: string,
  ): Promise<ConsoleSearchResults> {
    return searchVisibleConsoles(
      readAviaryConsoles(),
      TELESCOPE_CONSOLE_ID,
      current.context,
      typeof q === 'string' ? q : '',
    );
  }
}
