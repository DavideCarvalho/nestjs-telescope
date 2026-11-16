// packages/core/src/discovery/client.ts
//
// A tenant's copy of the control plane's map: the saved snapshot at boot, then a long poll the
// control plane answers as soon as the map changes. While it is unreachable the last map stays in
// use (in memory and on disk), and the poll retries with backoff.
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runAsTelescopeWork } from '../otel/telescope-runtime.js';
import { ServerUrl } from '../topology/server-url.js';
import { type TenantTokenSource, resolveTenantToken } from '../topology/tenant-auth.js';
import type { DiscoveryMap, ServiceDirectory } from './directory.js';

/** Options of {@link DiscoveryClient}. */
export interface DiscoveryClientOptions {
  /**
   * The control plane's telescope URL (`https://telescope.internal/telescope`), or the tenant's
   * {@link ServerUrl} (looked up on the first poll, and again after an error or a 404).
   */
  url: string | ServerUrl;
  token: TenantTokenSource;
  /** This app (advisory: the token decides). Stamps the snapshot. */
  partition: string;
  directory: ServiceDirectory;
  /** Where the last map is saved, and read back at boot. */
  snapshotPath: string;
  /** How long the control plane may hold a request. Default 25 s. */
  waitMs?: number;
  fetch?: typeof fetch;
  onError?: (message: string) => void;
}

/** The discovery endpoint under a control plane's telescope URL. */
export function discoveryUrl(url: string): string {
  return `${url.replace(/\/+$/, '')}/api/discovery`;
}

/**
 * A saved snapshot, or `null` when there is none, it is unreadable, or it was written for another
 * scope (another app or control plane sharing the path).
 */
export function readSnapshot(path: string, scope?: string): DiscoveryMap | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DiscoveryMap> & {
      scope?: unknown;
    };
    if (
      typeof parsed.version !== 'string' ||
      parsed.apps === null ||
      typeof parsed.apps !== 'object'
    ) {
      return null;
    }
    if (scope !== undefined && parsed.scope !== scope) return null;
    return { version: parsed.version, apps: parsed.apps };
  } catch {
    return null;
  }
}

/** Save `map` atomically (a temp file renamed over the old one), stamped with its scope. */
export async function writeSnapshot(
  path: string,
  map: DiscoveryMap,
  scope?: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const stamped = {
    ...map,
    ...(scope !== undefined ? { scope } : {}),
    savedAt: new Date().toISOString(),
  };
  await writeFile(temp, JSON.stringify(stamped));
  await rename(temp, path);
}

export class DiscoveryClient {
  private stopped = true;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  /** Ends the backoff sleep early, so `stop()` never waits it out. */
  private wake: (() => void) | null = null;
  private readonly fetchImpl: typeof fetch;
  /** Whose snapshot it is: this control plane and this app. */
  private readonly scope: string;
  private readonly server: ServerUrl;

  constructor(private readonly options: DiscoveryClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.server = options.url instanceof ServerUrl ? options.url : new ServerUrl(options.url);
    // A looked-up URL is unknown at boot: its snapshot is scoped to the app alone.
    const known = this.server.lazy ? null : this.server.current;
    this.scope = `${known !== null ? discoveryUrl(known) : 'lazy'}#${options.partition}`;
  }

  /** Load the snapshot (synchronously, before the first request), then start polling. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const saved = readSnapshot(this.options.snapshotPath, this.scope);
    if (saved !== null) this.options.directory.update(saved);
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    this.wake?.();
    await this.loop?.catch(() => {});
    this.loop = null;
  }

  /** One request: `true` when the control plane answered with a map. */
  async pollOnce(waitMs = this.options.waitMs ?? 25_000): Promise<boolean> {
    const directory = this.options.directory;
    const params = new URLSearchParams({ wait: String(Math.round(waitMs / 1000)) });
    if (directory.version !== null) params.set('since', directory.version);
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), waitMs + 10_000);
    timer.unref?.();
    try {
      const base = await this.server.get();
      // Telescope's own work: no trace header, no rewrite, no OpenTelemetry span.
      let response: Response;
      try {
        response = await runAsTelescopeWork(async () => {
          const token = await resolveTenantToken(this.options.token);
          return this.fetchImpl(`${discoveryUrl(base)}?${params}`, {
            headers: { authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
        });
      } catch (error) {
        // Unreachable: a looked-up URL is looked up again before the next poll.
        if (!this.stopped && this.server.lazy) await this.server.refresh().catch(() => undefined);
        throw error;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 404 && this.server.lazy) {
          await this.server.refresh().catch(() => undefined);
        }
        this.options.onError?.(`the control plane answered ${response.status} to /api/discovery`);
        return false;
      }
      const body = (await response.json()) as Partial<DiscoveryMap>;
      if (typeof body.version !== 'string' || body.apps === null || typeof body.apps !== 'object') {
        return false;
      }
      const map: DiscoveryMap = { version: body.version, apps: body.apps };
      if (map.version !== directory.version) {
        directory.update(map);
        await writeSnapshot(this.options.snapshotPath, map, this.scope).catch((error: unknown) =>
          this.options.onError?.(
            `could not save the discovery snapshot: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
      return true;
    } catch (error) {
      if (!this.stopped) {
        this.options.onError?.(
          `could not read the discovery map: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return false;
    } finally {
      clearTimeout(timer);
      this.controller = null;
    }
  }

  private async run(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      const ok = await this.pollOnce();
      if (this.stopped) return;
      if (ok) {
        backoff = 1000;
        continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoff);
        timer.unref?.();
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
      backoff = Math.min(30_000, backoff * 2);
    }
  }
}
