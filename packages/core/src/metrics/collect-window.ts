// packages/core/src/metrics/collect-window.ts
import type { Entry } from '../entry/entry.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';

/**
 * Entries fetched per storage page (default). Large on purpose: the analytics
 * window scan is the only caller, and paginating in small pages turns one scan
 * into many sequential round-trips — which dominates latency against a REMOTE
 * SQL store (e.g. each 500-row page over a remote RDS adds a full RTT). A big
 * page collapses a typical window into one or two queries. Paired with
 * `omitContent`, each page stays cheap on the wire regardless of content size.
 */
export const DEFAULT_PAGE_SIZE = 5000;
/** Safety cap on entries scanned per request; surfaced via `truncated` (default). */
export const DEFAULT_SCAN_CAP = 50_000;

export interface WindowReadOptions {
  pageSize?: number;
  scanCap?: number;
}

export interface WindowReadResult {
  entries: Entry[];
  /** Number of entries returned (<= scanCap). */
  scanned: number;
  /** True if the scan hit the cap (older entries in the window were not read). */
  truncated: boolean;
}

/** Page through `storage.get` for all entries matching `baseQuery`, newest-first,
 *  bounded by `scanCap`. Terminates safely even against a non-compliant store:
 *  an empty page or a non-advancing cursor ends the scan (the cap alone cannot
 *  catch an empty-page-with-cursor loop, since `entries` would never grow). */
export async function collectEntriesInWindow(
  storage: StorageProvider,
  baseQuery: Omit<EntryQuery, 'cursor' | 'limit'>,
  options: WindowReadOptions = {},
): Promise<WindowReadResult> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const scanCap = options.scanCap ?? DEFAULT_SCAN_CAP;

  const entries: Entry[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (;;) {
    const query: EntryQuery = {
      ...baseQuery,
      limit: pageSize,
      ...(cursor !== undefined ? { cursor } : {}),
    };
    const page = await storage.get(query);
    if (page.data.length === 0) break;
    entries.push(...page.data);
    if (entries.length >= scanCap) {
      truncated = true;
      break;
    }
    if (page.nextCursor === null || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }

  return {
    entries: entries.slice(0, scanCap),
    scanned: Math.min(entries.length, scanCap),
    truncated,
  };
}
