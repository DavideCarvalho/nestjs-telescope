import { useId, useState } from 'react';
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
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../react/ui/index.js';

type ExportFormat = 'json' | 'csv';

/** Value→label maps for the two selects, so the trigger shows the label not the id. */
const FORMAT_ITEMS: Record<string, string> = { json: 'JSON', csv: 'CSV' };
const TYPE_ITEMS: Record<string, string> = {
  all: 'all',
  ...Object.fromEntries(ENTRY_TYPES.map((entryType) => [entryType.id, entryType.label])),
};

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
    <div className="rounded-lg border border-line">
      <Table className="min-w-[640px] text-left">
        <TableHeader>
          <TableRow>
            <TableHead>Filename</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Rows</TableHead>
            <TableHead>Format</TableHead>
            <TableHead>Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => (
            <TableRow key={`${record.filename}:${record.at}`} className="hover:bg-panel">
              <TableCell className="font-mono text-foreground">{record.filename}</TableCell>
              <TableCell className="text-muted-foreground">{record.type}</TableCell>
              <TableCell className="tabular-nums text-foreground">
                {record.rows.toLocaleString()}
              </TableCell>
              <TableCell className="uppercase text-muted-foreground">{record.format}</TableCell>
              <TableCell className="text-muted-foreground">
                {new Date(record.at).toLocaleTimeString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function ExportsPage(): JSX.Element {
  const client = useTelescopeClient();
  const searchId = useId();
  const limitId = useId();
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
    const windowStartMs = Date.now() - (WINDOW_MS[window] ?? WINDOW_MS['1h']!);
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
        <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Export workbench
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Page captured entries into a downloadable JSON or CSV file. Gathering runs in your browser
          against the live store, newest-first within the selected window.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-panel/40 p-4">
        {/* Not a <label>: Select renders a button trigger, which a label cannot bind to. */}
        <div className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Type
          {/* `items` lets <SelectValue> render the human label rather than the raw id. */}
          <Select
            items={TYPE_ITEMS}
            value={type}
            onValueChange={(next) => {
              if (typeof next === 'string') setType(next);
            }}
          >
            <SelectTrigger aria-label="Entry type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">all</SelectItem>
              {ENTRY_TYPES.map((entryType) => (
                <SelectItem key={entryType.id} value={entryType.id}>
                  {entryType.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Not a <label>: WindowSelect renders its own <select>, so wrapping it in a
            label has no native control to bind to (a11y/noLabelWithoutControl). */}
        <div className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Window
          <WindowSelect value={window} onChange={setWindow} />
        </div>

        {/* `htmlFor` rather than wrapping: <Input> is a component, so a static a11y check
            cannot see the <input> it renders. */}
        <label
          className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-muted-foreground"
          htmlFor={searchId}
        >
          Search
          <Input
            id={searchId}
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="content filter"
          />
        </label>

        <label
          className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-muted-foreground"
          htmlFor={limitId}
        >
          Limit
          <Input
            id={limitId}
            type="number"
            min={1}
            max={MAX_LIMIT}
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value) || DEFAULT_LIMIT)}
            className="w-24 tabular-nums"
          />
        </label>

        {/* Not a <label>: Select renders a button trigger, which a label cannot bind to. */}
        <div className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Format
          <Select
            items={FORMAT_ITEMS}
            value={format}
            onValueChange={(next) => setFormat(next === 'csv' ? 'csv' : 'json')}
          >
            <SelectTrigger aria-label="Export format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="csv">CSV</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button onClick={onExport} disabled={exporting} size="md">
          {exporting ? 'Exporting…' : 'Export'}
        </Button>

        {exporting && liveCount !== null && (
          <span className="text-xs tabular-nums text-muted-foreground">
            gathered {liveCount.toLocaleString()}…
          </span>
        )}
      </div>

      {error && <p className="px-1 text-xs text-bad">{error}</p>}

      <div className="space-y-2">
        <h4 className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Recent exports (this session)
        </h4>
        {records.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-xs text-muted-foreground">
            No exports yet. Pick a type, window, and format, then export.
          </div>
        ) : (
          <RecentExports records={records} />
        )}
      </div>
    </div>
  );
}
