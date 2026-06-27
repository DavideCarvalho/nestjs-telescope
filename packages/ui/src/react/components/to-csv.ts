/**
 * Pure, dependency-free CSV serialization for telescope entries, used by the
 * Exports screen. Flattens the top-level entry fields (the columns a triage
 * spreadsheet actually wants) plus a stringified `content` blob — nested content
 * shapes vary by type, so we serialize the whole thing into one escaped cell
 * rather than exploding into a ragged column set. Kept framework-free so it can
 * be unit-tested in isolation, mirroring `export-json.ts`.
 */

import type { Entry } from '../../client/index.js';

/** The fixed CSV column order. `content` is the JSON-stringified entry content. */
export const CSV_COLUMNS = [
  'id',
  'type',
  'createdAt',
  'durationMs',
  'tags',
  'familyHash',
  'traceId',
  'content',
] as const;

/**
 * Escape a single CSV field per RFC 4180: if it contains a quote, comma, or
 * newline (CR or LF), wrap it in double quotes and double any embedded quotes.
 * Plain fields pass through untouched so the common case stays readable.
 */
export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Serialize an arbitrary value for the `content` cell, never throwing. */
function stringifyContent(content: unknown): string {
  if (content === null || content === undefined) return '';
  try {
    return JSON.stringify(content) ?? String(content);
  } catch {
    return String(content);
  }
}

/** One CSV row of cells (pre-escape) for an entry, in {@link CSV_COLUMNS} order. */
function rowFor(entry: Entry): string[] {
  return [
    entry.id,
    entry.type,
    entry.createdAt,
    entry.durationMs === null ? '' : String(entry.durationMs),
    entry.tags.join('; '),
    entry.familyHash ?? '',
    entry.traceId ?? '',
    stringifyContent(entry.content),
  ];
}

/**
 * Render entries as a CSV document (header row + one row per entry), CRLF-
 * terminated per RFC 4180. Every cell is escaped via {@link escapeCsvField}.
 */
export function entriesToCsv(entries: Entry[]): string {
  const lines = [CSV_COLUMNS.map(escapeCsvField).join(',')];
  for (const entry of entries) {
    lines.push(rowFor(entry).map(escapeCsvField).join(','));
  }
  return lines.join('\r\n');
}

/** Trigger a browser download of `csv` text under `filename`, mirroring `downloadJson`. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
