// packages/core/src/discovery/config.ts
//
// `discovery` in `TelescopeModule.forRoot()`: reach your apps by name, `fetch('http://billing/…')`.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** `discovery` in `TelescopeModule.forRoot()`. */
export interface DiscoveryOptions {
  /**
   * App name → base URL. These resolve first, ahead of the control plane's map: a standalone app's
   * whole directory, or a local-development override (`billing: 'http://localhost:3334'`).
   */
  apps?: Record<string, string>;
  /**
   * Where a tenant keeps the last map the control plane sent, so names keep resolving while it is
   * down or the app restarts without it. Default `telescope-discovery-<partition>.json` in the OS
   * temp directory. A snapshot written for another app or control plane is never read.
   */
  snapshotPath?: string;
  /**
   * Fail a call to an app the control plane knows but has no live instance of, instead of sending
   * it to the last URL seen. Default `false`.
   */
  failFast?: boolean;
  /**
   * Fail a call to a single-label host that names no app (`http://billng/…`) with "app billng is
   * not registered" instead of letting it go out as written. Default `false`: an unknown
   * single-label host (a Docker Compose service such as `http://minio:9000`) goes out untouched.
   */
  strict?: boolean;
  /** With `strict`: single-label hosts that are not apps (`minio`). `localhost` always passes. */
  passthrough?: string[];
  /** Also resolve names in `http.request` / `https.request` (axios, got). Default `false`. */
  nodeHttp?: boolean;
  /**
   * A tenant on a broker transport: the control plane's telescope URL to read the map from
   * (`https://telescope.internal/telescope`). A tenant on HTTP uses `tenant.url`.
   */
  serverUrl?: string;
}

/** {@link DiscoveryOptions} with defaults. */
export interface ResolvedDiscovery {
  enabled: boolean;
  /** Lowercase app name → base URL. */
  apps: Record<string, string>;
  snapshotPath: string | null;
  failFast: boolean;
  strict: boolean;
  passthrough: Set<string>;
  nodeHttp: boolean;
  serverUrl: string | null;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,63}$/;

/** An app's base URL: an absolute http(s) URL, without credentials, query, hash or trailing slash. */
export function normalizeAppUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** The default snapshot file of app `partition`. */
export function defaultSnapshotPath(partition: string): string {
  return join(tmpdir(), `telescope-discovery-${partition.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

/** Resolve `discovery`. Throws on a malformed app name or URL. */
export function resolveDiscovery(options: DiscoveryOptions | false | undefined): ResolvedDiscovery {
  const raw = options === false ? {} : (options ?? {});
  const apps: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw.apps ?? {})) {
    if (!NAME_RE.test(name)) {
      throw new Error(
        `telescope: discovery.apps.${name}: an app name is one DNS label (A-Z a-z 0-9 _ -), so it can be a URL host.`,
      );
    }
    const url = normalizeAppUrl(value);
    if (url === null) {
      throw new Error(`telescope: discovery.apps.${name} must be an absolute http(s) URL.`);
    }
    apps[name.toLowerCase()] = url;
  }
  const serverUrl = raw.serverUrl === undefined ? null : normalizeAppUrl(raw.serverUrl);
  if (raw.serverUrl !== undefined && serverUrl === null) {
    throw new Error('telescope: discovery.serverUrl must be an absolute http(s) URL.');
  }
  const passthrough = raw.passthrough ?? [];
  if (!Array.isArray(passthrough) || !passthrough.every((host) => typeof host === 'string')) {
    throw new Error('telescope: discovery.passthrough must be a list of host names.');
  }
  return {
    enabled: options !== false,
    apps,
    snapshotPath:
      typeof raw.snapshotPath === 'string' && raw.snapshotPath !== '' ? raw.snapshotPath : null,
    failFast: raw.failFast === true,
    strict: raw.strict === true,
    passthrough: new Set(['localhost', ...passthrough.map((host) => host.toLowerCase())]),
    nodeHttp: raw.nodeHttp === true,
    serverUrl,
  };
}
