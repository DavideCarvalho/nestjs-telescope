// packages/core/src/discovery/directory.ts
//
// The map of app name → URL this process resolves `http://<app>/…` with, and the contract other
// libraries read it through. Two sources, the static one winning: `discovery.apps`, and the map
// the control plane keeps from its fleet (by the URL each app's heartbeat carries).
import { isAppName } from './config.js';

/** One app as the control plane describes it. */
export interface DiscoveredApp {
  /** Its base URL (the most recently seen live instance's). */
  url: string;
  /** Live instances right now. `0`: known, but none is up. */
  live: number;
}

/** What the control plane sends, and what a tenant saves as its snapshot. */
export interface DiscoveryMap {
  /** Changes whenever the map does. */
  version: string;
  apps: Record<string, DiscoveredApp>;
}

/**
 * The contract on `globalThis[Symbol.for('@dudousxd/aviary:discovery')]`: how any library learns
 * which app a call goes to without depending on telescope. Read it lazily, at call time: telescope
 * publishes it at boot and removes it at shutdown.
 */
export interface DiscoveryContract {
  /**
   * The base URL a call to app `name` (case-insensitive) goes to, exactly as the rewrite sends it.
   * `undefined` when `name` is not an app, or (with `failFast`) when it has no live instance.
   */
  resolve(name: string): string | undefined;
  /** The app an origin (`https://billing.internal`) belongs to, or `undefined`. */
  appOf(origin: string): string | undefined;
  /** Called with no argument whenever the map changes. Returns the function that unsubscribes. */
  subscribe(listener: () => void): () => void;
}

/** Global slot of the {@link DiscoveryContract}. */
export const DISCOVERY_SLOT = Symbol.for('@dudousxd/aviary:discovery');

/** Where a name resolved. */
export type Resolution =
  | { kind: 'url'; url: string }
  /** The control plane knows the app, but it has no live instance. `url` is the last seen. */
  | { kind: 'down'; url: string }
  | { kind: 'unknown' };

function originOf(url: string): string | null {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** The map this process resolves names with. */
export class ServiceDirectory implements DiscoveryContract {
  private readonly listeners = new Set<() => void>();
  private registry: Record<string, DiscoveredApp> = Object.create(null);
  private registryVersion: string | null = null;
  private byOrigin = new Map<string, string>();
  private readonly staticApps: Record<string, string>;

  constructor(
    staticApps: Record<string, string> = {},
    private readonly options: { failFast?: boolean } = {},
  ) {
    // Null-prototype copies: no app name (`__proto__`) can reach an object prototype.
    this.staticApps = Object.assign(Object.create(null), staticApps);
    this.reindex();
  }

  /** The version of the control plane's map this directory holds, or `null`. */
  get version(): string | null {
    return this.registryVersion;
  }

  /** The control plane's map as last received. */
  get map(): DiscoveryMap | null {
    return this.registryVersion === null
      ? null
      : { version: this.registryVersion, apps: { ...this.registry } };
  }

  /** Replace the control plane's map with `map`. */
  update(map: DiscoveryMap): void {
    if (map.version === this.registryVersion) return;
    const next: Record<string, DiscoveredApp> = Object.create(null);
    for (const [name, app] of Object.entries(map.apps)) {
      if (
        isAppName(name) &&
        app !== null &&
        typeof app === 'object' &&
        typeof app.url === 'string'
      ) {
        next[name.toLowerCase()] = { url: app.url, live: Math.max(0, Number(app.live) || 0) };
      }
    }
    this.registry = next;
    this.registryVersion = map.version;
    this.reindex();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** How `name` resolves. */
  lookup(name: string): Resolution {
    const key = name.toLowerCase();
    const fixed = Object.hasOwn(this.staticApps, key) ? this.staticApps[key] : undefined;
    if (fixed !== undefined) return { kind: 'url', url: fixed };
    const app = Object.hasOwn(this.registry, key) ? this.registry[key] : undefined;
    if (app === undefined) return { kind: 'unknown' };
    return app.live > 0 ? { kind: 'url', url: app.url } : { kind: 'down', url: app.url };
  }

  resolve(name: string): string | undefined {
    const found = this.lookup(name);
    if (found.kind === 'url') return found.url;
    if (found.kind === 'down' && this.options.failFast !== true) return found.url;
    return undefined;
  }

  appOf(origin: string): string | undefined {
    const normalized = originOf(origin);
    return normalized === null ? undefined : this.byOrigin.get(normalized);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private reindex(): void {
    const byOrigin = new Map<string, string>();
    for (const [name, app] of Object.entries(this.registry)) {
      const origin = originOf(app.url);
      if (origin !== null) byOrigin.set(origin, name);
    }
    // Static entries win.
    for (const [name, url] of Object.entries(this.staticApps)) {
      const origin = originOf(url);
      if (origin !== null) byOrigin.set(origin, name);
    }
    this.byOrigin = byOrigin;
  }
}

const slot = globalThis as Record<symbol, unknown>;

/** Publish `directory` on the global contract slot (replacing what was there). */
export function publishDirectory(directory: ServiceDirectory): () => void {
  const contract: DiscoveryContract = {
    resolve: (name) => directory.resolve(name),
    appOf: (origin) => directory.appOf(origin),
    subscribe: (listener) => directory.subscribe(listener),
  };
  slot[DISCOVERY_SLOT] = contract;
  return () => {
    if (slot[DISCOVERY_SLOT] === contract) slot[DISCOVERY_SLOT] = undefined;
  };
}
