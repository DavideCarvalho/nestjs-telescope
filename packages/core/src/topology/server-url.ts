// packages/core/src/topology/server-url.ts
//
// The control plane's URL, as a tenant knows it: a string, or a function that looks it up (e.g. from
// a discovery source) on the first send. A failed lookup is not cached (the entries stay buffered
// and the next send asks again); a send that cannot reach the URL asks for it again, so a control
// plane that moved is followed without a restart.

/**
 * Where the control plane is: its telescope URL (`https://telescope.internal/telescope`), or a
 * function resolving it, called on the first send rather than at boot. The function may carry a
 * `refresh()`, called (instead of the function) when the URL it gave stops answering.
 */
export type TelescopeServerUrlSource =
  | string
  | ((() => string | Promise<string>) & { refresh?: () => string | Promise<string> });

/** Whether `url` is an absolute http(s) URL. */
function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validates a source at boot: a non-empty string, or a function. */
export function assertServerUrlSource(source: unknown, what: string): void {
  if (typeof source === 'function') return;
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error(`telescope: ${what} must be a URL string or a function returning one.`);
  }
}

/**
 * The resolved control-plane URL, shared by everything a tenant sends to it (batches, discovery):
 * resolved once, cached, and looked up again only through {@link ServerUrl.refresh}.
 */
export class ServerUrl {
  private cached: string | null;
  private pending: Promise<string> | null = null;

  constructor(private readonly source: TelescopeServerUrlSource) {
    // A string is used as given (as before); only a looked-up URL is validated.
    this.cached = typeof source === 'string' ? source.trim().replace(/\/+$/, '') : null;
  }

  /** Whether the URL comes from a function (and so may change). */
  get lazy(): boolean {
    return typeof this.source === 'function';
  }

  /** The URL already resolved, without resolving it. */
  get current(): string | null {
    return this.cached;
  }

  /** The URL, resolving it on the first call. Rejects (and caches nothing) when the lookup fails. */
  get(): Promise<string> {
    if (this.cached !== null) return Promise.resolve(this.cached);
    return this.lookup(false);
  }

  /**
   * Looks the URL up again (the function's `refresh()`, else the function) after it stopped
   * answering. Resolves to the new URL, or the cached one for a string source.
   */
  refresh(): Promise<string> {
    if (typeof this.source === 'string') return this.get();
    return this.lookup(true);
  }

  private lookup(refresh: boolean): Promise<string> {
    if (this.pending !== null) return this.pending;
    const source = this.source as Exclude<TelescopeServerUrlSource, string>;
    const run = (async () => {
      const raw = refresh && typeof source.refresh === 'function' ? source.refresh() : source();
      const url = normalize(await raw);
      this.cached = url;
      return url;
    })().finally(() => {
      this.pending = null;
    });
    this.pending = run;
    return run;
  }
}

/** A looked-up URL, trimmed of its trailing slashes; throws a clear error for a bad one. */
function normalize(raw: unknown): string {
  if (typeof raw !== 'string' || !isHttpUrl(raw.trim())) {
    throw new Error(
      `telescope: the control plane URL must be an absolute http(s) URL (got ${JSON.stringify(raw)}).`,
    );
  }
  return raw.trim().replace(/\/+$/, '');
}
