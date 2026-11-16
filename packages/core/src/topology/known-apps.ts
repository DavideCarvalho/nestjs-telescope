// packages/core/src/topology/known-apps.ts
//
// The apps a control plane has seen, for the console's App picker, without counting the tags of
// the whole entries table on every request. Fed by the ingest (every stored batch names its app),
// and reconciled with the store at most every few minutes (so apps other replicas ingested, or
// that were ingested before a restart, show up too).
import { Inject, Injectable } from '@nestjs/common';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { withoutTenantView } from '../storage/tenant-scoped-storage.js';
import { APP_TAG_PREFIX } from './wire.js';

/** How often the store is read again for apps (one bounded tag count). */
export const KNOWN_APPS_REFRESH_MS = 5 * 60_000;
/** How many apps are kept, and read from the store at most. */
const MAX_APPS = 5_000;

@Injectable()
export class TelescopeKnownApps {
  private readonly apps = new Set<string>();
  private refreshedAt: number | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(@Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider) {}

  /** Notes an app the control plane just stored entries of. */
  note(app: string): void {
    if (app === '' || this.apps.has(app)) return;
    if (this.apps.size >= MAX_APPS) return;
    this.apps.add(app);
  }

  /**
   * The known apps, sorted. The first call reads the store (one bounded tag count); later calls answer from memory and refresh in the background once the last read is
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
        const prefix = `${APP_TAG_PREFIX}:`;
        const rows = await withoutTenantView(() => this.storage.tags(prefix, { limit: MAX_APPS }));
        for (const row of rows) this.note(row.tag.slice(prefix.length));
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
}
