import { useState } from 'react';
import type { EntriesQuery, Entry, TelescopeClient } from '../../client/index.js';
import {
  ENTRY_TYPES,
  WindowSelect,
  downloadCsv,
  downloadJson,
  entriesToCsv,
  resolveEntryQuery,
  useTelescopeClient,
} from '../../react/index.js';

type ExportFormat = 'json' | 'csv';

/** One completed export this session (kept in component state, never persisted). */
interface ExportRecord {
  filename: string;
  type: string;
  rows: number;
  format: ExportFormat;
  at: number;
}

/** Per-request page size while gathering — bounded so one export can't fire a huge query. */
const PAGE_SIZE = 200;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;

const WINDOW_MS: Record<string, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

const INPUT_CLASS = 'rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300';

/** Backend filter for the chosen type; 'all' means no type filter. */
function typeFilter(type: string): EntriesQuery {
  return type === 'all' ? {} : resolveEntryQuery(type);
}

/**
 * Page the existing `entries` endpoint (newest-first, keyset cursor) up to
 * `limit` rows, stopping early once an entry falls outside the window — entries
 * are newest-first, so the first out-of-window row means every later one is too.
 * `onProgress` reports the running count so the page can show a live tally.
 */
async function collectEntries(
  client: TelescopeClient,
  base: EntriesQuery,
  limit: number,
  windowStartMs: number,
  onProgress: (count: number) => void,
): Promise<Entry[]> {
  const rows: Entry[] = [];
  let cursor: string | undefined;
  while (rows.length < limit) {
    const pageLimit = Math.min(PAGE_SIZE, limit - rows.length);
    const page = await client.entries({
      ...base,
      limit: pageLimit,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    let reachedWindowEdge = false;
    for (const entry of page.data) {
      if (new Date(entry.createdAt).getTime() < windowStartMs) {
        reachedWindowEdge = true;
        break;
      }
      rows.push(entry);
      if (rows.length >= limit) break;
    }
    onProgress(rows.length);
    if (reachedWindowEdge || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return rows;
}

function RecentExports({ records }: { records: ExportRecord[] }): JSX.Element | null {
  if (records.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-zinc-500">
            <th className="px-3 py-2 font-normal">Filename</th>
            <th className="px-3 py-2 font-normal">Type</th>
            <th className="px-3 py-2 font-normal">Rows</th>
            <th className="px-3 py-2 font-normal">Format</th>
            <th className="px-3 py-2 font-normal">Time</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr
              key={`${record.filename}:${record.at}`}
              className="border-t border-zinc-800/60 hover:bg-zinc-900/40"
            >
              <td className="px-3 py-2 font-mono text-xs text-zinc-300">{record.filename}</td>
              <td className="px-3 py-2 text-xs text-zinc-400">{record.type}</td>
              <td className="px-3 py-2 text-xs tabular-nums text-zinc-100">
                {record.rows.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-xs uppercase text-zinc-400">{record.format}</td>
              <td className="px-3 py-2 text-xs text-zinc-400">
                {new Date(record.at).toLocaleTimeString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExportsPage(): JSX.Element {
  const client = useTelescopeClient();
  const [type, setType] = useState('all');
  const [window, setWindow] = useState('1h');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [format, setFormat] = useState<ExportFormat>('json');
  const [exporting, setExporting] = useState(false);
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<ExportRecord[]>([]);

  async function onExport(): Promise<void> {
    setExporting(true);
    setError(null);
    setLiveCount(0);
    const effectiveLimit = Math.min(Math.max(1, limit), MAX_LIMIT);
    const windowStartMs = Date.now() - (WINDOW_MS[window] ?? WINDOW_MS['1h']);
    const base: EntriesQuery = {
      ...typeFilter(type),
      ...(search.trim() !== '' ? { search: search.trim() } : {}),
    };
    try {
      const rows = await collectEntries(client, base, effectiveLimit, windowStartMs, setLiveCount);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `telescope-export-${type}-${stamp}.${format}`;
      if (format === 'csv') {
        downloadCsv(filename, entriesToCsv(rows));
      } else {
        downloadJson(filename, rows);
      }
      setRecords((prev) => [
        { filename, type, rows: rows.length, format, at: Date.now() },
        ...prev,
      ]);
    } catch {
      setError('Export failed while gathering entries.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4 p-4">
      <div className="px-1">
        <h3 className="text-[10px] uppercase tracking-wide text-zinc-500">Export workbench</h3>
        <p className="mt-1 text-xs text-zinc-600">
          Page captured entries into a downloadable JSON or CSV file. Gathering runs in your browser
          against the live store, newest-first within the selected window.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-zinc-500">
          Type
          <select
            value={type}
            onChange={(event) => setType(event.target.value)}
            className={INPUT_CLASS}
          >
            <option value="all">all</option>
            {ENTRY_TYPES.map((entryType) => (
              <option key={entryType.id} value={entryType.id}>
                {entryType.label}
              </option>
            ))}
          </select>
        </label>

        {/* Not a <label>: WindowSelect renders its own <select>, so wrapping it in a
            label has no native control to bind to (a11y/noLabelWithoutControl). */}
        <div className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-zinc-500">
          Window
          <WindowSelect value={window} onChange={setWindow} />
        </div>

        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-zinc-500">
          Search
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="content filter"
            className={INPUT_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-zinc-500">
          Limit
          <input
            type="number"
            min={1}
            max={MAX_LIMIT}
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value) || DEFAULT_LIMIT)}
            className={`${INPUT_CLASS} w-24 tabular-nums`}
          />
        </label>

        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-zinc-500">
          Format
          <select
            value={format}
            onChange={(event) => setFormat(event.target.value === 'csv' ? 'csv' : 'json')}
            className={INPUT_CLASS}
          >
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
          </select>
        </label>

        <button
          type="button"
          onClick={onExport}
          disabled={exporting}
          className="rounded border border-zinc-700 px-3 py-1.5 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exporting ? 'Exporting…' : 'Export'}
        </button>

        {exporting && liveCount !== null && (
          <span className="text-xs tabular-nums text-zinc-500">
            gathered {liveCount.toLocaleString()}…
          </span>
        )}
      </div>

      {error && <p className="px-1 text-xs text-red-400">{error}</p>}

      <div className="space-y-2">
        <h4 className="px-1 text-[10px] uppercase tracking-wide text-zinc-500">
          Recent exports (this session)
        </h4>
        {records.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-10 text-center text-xs text-zinc-600">
            No exports yet. Pick a type, window, and format, then export.
          </div>
        ) : (
          <RecentExports records={records} />
        )}
      </div>
    </div>
  );
}
