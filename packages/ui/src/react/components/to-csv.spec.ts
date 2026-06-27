import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../../client/index.js';
import { CSV_COLUMNS, downloadCsv, entriesToCsv, escapeCsvField } from './to-csv.js';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'e1',
    batchId: 'b1',
    type: 'request',
    familyHash: null,
    content: { ok: true },
    tags: [],
    sequence: 0,
    durationMs: 12,
    origin: 'http',
    instanceId: 'i1',
    traceId: null,
    spanId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

describe('escapeCsvField', () => {
  it('passes plain values through untouched', () => {
    expect(escapeCsvField('hello')).toBe('hello');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes fields containing commas', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
  });

  it('quotes fields containing newlines (LF and CR)', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"');
  });
});

describe('entriesToCsv', () => {
  it('emits a header row in the fixed column order', () => {
    const csv = entriesToCsv([]);
    expect(csv).toBe(CSV_COLUMNS.join(','));
  });

  it('serializes top-level fields, joins tags, and stringifies content', () => {
    const csv = entriesToCsv([
      entry({
        id: 'e1',
        type: 'query',
        tags: ['slow', 'n+1'],
        familyHash: 'fam1',
        traceId: 'tr1',
        durationMs: 99,
        content: { sql: 'SELECT 1' },
      }),
    ]);
    const [header, row] = csv.split('\r\n');
    expect(header).toBe('id,type,createdAt,durationMs,tags,familyHash,traceId,content');
    expect(row).toBe(
      'e1,query,2026-06-01T00:00:00.000Z,99,slow; n+1,fam1,tr1,"{""sql"":""SELECT 1""}"',
    );
  });

  it('renders null durationMs/familyHash/traceId as empty cells', () => {
    const csv = entriesToCsv([
      entry({ id: 'e2', durationMs: null, familyHash: null, traceId: null, content: null }),
    ]);
    const row = csv.split('\r\n')[1];
    expect(row).toBe('e2,request,2026-06-01T00:00:00.000Z,,,,,');
  });

  it('escapes a content cell that contains commas and quotes into one field', () => {
    const content = { msg: 'a, "b"' };
    const csv = entriesToCsv([entry({ content })]);
    const row = csv.split('\r\n')[1];
    // The content cell is the trailing field, escaped exactly as escapeCsvField
    // would escape the stringified content — one quoted field, no raw commas leak.
    const expectedCell = escapeCsvField(JSON.stringify(content));
    expect(row.endsWith(expectedCell)).toBe(true);
    expect(expectedCell.startsWith('"')).toBe(true);
    expect(expectedCell.endsWith('"')).toBe(true);
  });
});

describe('downloadCsv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('creates an anchor with the filename and clicks it', () => {
    const anchor = document.createElement('a');
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => {});
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(anchor);
    const createObjectURL = vi.fn(() => 'blob:url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    downloadCsv('telescope-export.csv', 'a,b\r\n1,2');

    expect(anchor.download).toBe('telescope-export.csv');
    expect(anchor.getAttribute('href')).toBe('blob:url');
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:url');
    createElement.mockRestore();
  });
});
