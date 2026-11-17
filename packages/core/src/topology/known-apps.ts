// packages/core/src/topology/known-apps.ts
//
// The apps a control plane has seen, for the console's App picker, without counting the tags of
// the whole entries table. Fed by the ingest (every stored batch names its app), and reconciled at
// most every few minutes with the fleet's instance registry (one row per instance, so apps other
// replicas ingested, or that heartbeat since a restart, show up too). Only without a registry (a
// standalone app, `fleet: false`), or while it is still empty, is the store read instead: the
// `app:` tags of its newest entries, never the whole table.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { TelescopeFleet } from '../fleet/fleet.service.js';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { withoutTenantView } from '../storage/tenant-scoped-storage.js';
import { APP_TAG_PREFIX } from './wire.js';

/** How often the apps are read again (the instance registry, else a bounded tag count). */
export const KNOWN_APPS_REFRESH_MS = 5 * 60_000;
/** How many apps are kept, and read from the store at most. */
const MAX_APPS = 5_000;
/** The fallback's bound: only the `app:` tags of this many newest entries are counted. */
export const KNOWN_APPS_RECENT_ENTRIES = 50_000;

/** Where the known apps are reconciled from: the fleet's instance registry. */
export interface KnownAppsSource {
  /** The apps of the instance registry, or `null` when there is none. */
  instanceApps(): Promise<string[] | null>;
}

@Injectable()
export class TelescopeKnownApps {
  private readonly apps = new Set<string>();
  private refreshedAt: number | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Optional() @Inject(TelescopeFleet) private readonly fleet?: KnownAppsSource | null,
  ) {}

  /** Notes an app the control plane just stored entries of. */
  note(app: string): void {
    if (app === '' || this.apps.has(app)) return;
    if (this.apps.size >= MAX_APPS) return;
    this.apps.add(app);
  }

  /**
   * The known apps, sorted. The first call reads the instance registry (else one bounded tag
   * count); later calls answer from memory and refresh in the background once the last read is
   * older than {@link KNOWN_APPS_REFRESH_MS}.
   */
  async list(): Promise<string[]> {
    if (this.refreshedAt === null) await this.refresh();
    else if (Date.now() - this.refreshedAt >= KNOWN_APPS_REFRESH_MS) void this.refresh();
    return [...this.apps].sort();
  }

  private refresh(): Promise<void> {
    if (this.refreshing !== null) return this.refreshing;
    const run = (async () => {
      try {
        const registered = await this.instanceApps();
        if (registered !== null && registered.length > 0) {
          for (const app of registered) this.note(app);
        } else {
          await this.recentTags();
        }
      } catch {
        // The store is down: the apps noted so far still answer.
      }
      this.refreshedAt = Date.now();
    })().finally(() => {
      this.refreshing = null;
    });
    this.refreshing = run;
    return run;
  }

  /** The registry's apps; `null` without one, or when it cannot be read (then the store is). */
  private async instanceApps(): Promise<string[] | null> {
    if (!this.fleet) return null;
    try {
      return await this.fleet.instanceApps();
    } catch {
      return null;
    }
  }

  /** The `app:` tags of the newest entries only: a count that does not grow with the table. */
  private async recentTags(): Promise<void> {
    const prefix = `${APP_TAG_PREFIX}:`;
    const rows = await withoutTenantView(() =>
      this.storage.tags(prefix, { limit: MAX_APPS, recent: KNOWN_APPS_RECENT_ENTRIES }),
    );
    for (const row of rows) this.note(row.tag.slice(prefix.length));
  }
}
