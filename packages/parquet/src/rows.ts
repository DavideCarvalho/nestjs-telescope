import type { Entry } from '@dudousxd/nestjs-telescope';
import { isBatchOrigin, safeJsonParse } from '@dudousxd/nestjs-telescope';
import type { SchemaElement } from 'hyparquet';
import { ByteWriter, ParquetWriter } from 'hyparquet-writer';

/**
 * The cold file schema. Column names and types line up with the ClickHouse table, so
 * `INSERT … SELECT * FROM s3(…, 'Parquet')` loads the cold tier into ClickHouse as-is.
 */
export const SCHEMA: SchemaElement[] = [
  { name: 'root', num_children: 13 },
  { name: 'id', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'REQUIRED' },
  { name: 'batch_id', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'REQUIRED' },
  { name: 'type', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'REQUIRED' },
  { name: 'family_hash', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' },
  { name: 'tags', repetition_type: 'REQUIRED', converted_type: 'LIST', num_children: 1 },
  { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
  { name: 'element', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'REQUIRED' },
  { name: 'content', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'REQUIRED' },
  { name: 'sequence', type: 'INT64', repetition_type: 'REQUIRED' },
  { name: 'duration_ms', type: 'DOUBLE', repetition_type: 'OPTIONAL' },
  { name: 'origin', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'REQUIRED' },
  { name: 'instance_id', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'REQUIRED' },
  { name: 'trace_id', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' },
  { name: 'span_id', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' },
  {
    name: 'created_at',
    type: 'INT64',
    converted_type: 'TIMESTAMP_MILLIS',
    repetition_type: 'REQUIRED',
  },
];

export const ALL_COLUMNS = [
  'id',
  'batch_id',
  'type',
  'family_hash',
  'tags',
  'content',
  'sequence',
  'duration_ms',
  'origin',
  'instance_id',
  'trace_id',
  'span_id',
  'created_at',
] as const;

export type Column = (typeof ALL_COLUMNS)[number];

/** Columns with a bloom filter: the ones point lookups and trace/batch views filter on. */
const BLOOM_COLUMNS = new Set<Column>(['id', 'batch_id', 'trace_id']);

/** A row as hyparquet decodes it. Absent keys are columns that were not read. */
export interface ParquetRow {
  id: string;
  batch_id: string;
  type: string;
  family_hash: string | null | undefined;
  tags: string[] | null | undefined;
  content?: string;
  sequence: bigint | number;
  duration_ms: number | null | undefined;
  origin: string;
  instance_id: string;
  trace_id: string | null | undefined;
  span_id: string | null | undefined;
  created_at: Date;
}

/** The contract's page order: `createdAt` descending, then `id` descending (code-unit order). */
export function newestFirst(a: Entry, b: Entry): number {
  const delta = b.createdAt.getTime() - a.createdAt.getTime();
  if (delta !== 0) return delta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function oldestFirst(a: Entry, b: Entry): number {
  return -newestFirst(a, b);
}

export function rowToEntry(row: ParquetRow): Entry {
  return {
    id: row.id,
    batchId: row.batch_id,
    type: row.type,
    familyHash: row.family_hash ?? null,
    content: row.content === undefined ? null : safeJsonParse<unknown>(row.content, null),
    tags: row.tags ?? [],
    sequence: Number(row.sequence),
    durationMs: row.duration_ms ?? null,
    origin: isBatchOrigin(row.origin) ? row.origin : 'manual',
    instanceId: row.instance_id,
    traceId: row.trace_id ?? null,
    spanId: row.span_id ?? null,
    createdAt: new Date(row.created_at),
  };
}

function columnData(entries: Entry[]): { name: Column; data: unknown[]; bloomFilter?: boolean }[] {
  const data: Record<Column, unknown[]> = {
    id: [],
    batch_id: [],
    type: [],
    family_hash: [],
    tags: [],
    content: [],
    sequence: [],
    duration_ms: [],
    origin: [],
    instance_id: [],
    trace_id: [],
    span_id: [],
    created_at: [],
  };
  for (const entry of entries) {
    data.id.push(entry.id);
    data.batch_id.push(entry.batchId);
    data.type.push(entry.type);
    data.family_hash.push(entry.familyHash);
    data.tags.push(entry.tags);
    data.content.push(JSON.stringify(entry.content ?? null));
    data.sequence.push(BigInt(Math.trunc(entry.sequence)));
    data.duration_ms.push(entry.durationMs);
    data.origin.push(entry.origin);
    data.instance_id.push(entry.instanceId);
    data.trace_id.push(entry.traceId);
    data.span_id.push(entry.spanId);
    data.created_at.push(entry.createdAt);
  }
  return ALL_COLUMNS.map((name) => ({
    name,
    data: data[name],
    ...(BLOOM_COLUMNS.has(name) ? { bloomFilter: true } : {}),
  }));
}

/**
 * An in-memory Parquet file written in row groups as rows arrive. Rows MUST be appended in
 * `(createdAt, id)` ascending order: readers prune on the per-row-group `created_at` statistics
 * and rely on files being sorted.
 */
export class ParquetFileBuilder {
  private readonly writer = new ByteWriter();
  private readonly parquet = new ParquetWriter({ writer: this.writer, schema: SCHEMA });
  private pending: Entry[] = [];
  rows = 0;

  constructor(private readonly rowGroupSize: number) {}

  /** Bytes written so far, for callers that cut files at a target size. */
  get bytes(): number {
    return this.writer.offset;
  }

  append(entries: Entry[]): void {
    for (const entry of entries) this.pending.push(entry);
    this.rows += entries.length;
    while (this.pending.length >= this.rowGroupSize) {
      this.flushGroup(this.pending.splice(0, this.rowGroupSize));
    }
  }

  finish(): Uint8Array {
    if (this.pending.length > 0) this.flushGroup(this.pending.splice(0));
    this.parquet.finish();
    return this.writer.getBytes();
  }

  private flushGroup(entries: Entry[]): void {
    // ParquetWriter takes typed column arrays; the schema above fixes every column's type.
    this.parquet.write({
      columnData: columnData(entries) as Parameters<ParquetWriter['write']>[0]['columnData'],
      rowGroupSize: entries.length,
    });
  }
}

export function encodeFile(sorted: Entry[], rowGroupSize: number): Uint8Array {
  const builder = new ParquetFileBuilder(rowGroupSize);
  builder.append(sorted);
  return builder.finish();
}
