// packages/core/src/ai/diagnose-context-builder.ts
import type {
  ClientExceptionContent,
  ExceptionContent,
  QueryContent,
  RequestContent,
} from '../entry/content.js';
import { type Entry, EntryType } from '../entry/entry.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { DiagnoseContext } from './diagnoser.js';

/**
 * Cap on the number of in-batch query SQL strings carried into a diagnosis. The
 * NEWEST queries are the ones nearest the failure, so we keep the tail. A bound
 * matters because a single request can issue dozens of queries (N+1s especially);
 * an unbounded list would blow the model's context budget and the prompt cost.
 */
const RECENT_QUERY_LIMIT = 10;

/**
 * Per-query SQL length cap. A pathological generated statement (huge IN-lists)
 * would otherwise dominate the prompt; clipping keeps each query scannable while
 * preserving its shape (table/columns/joins) for the model.
 */
const QUERY_SQL_CHAR_LIMIT = 2_000;

/**
 * Build the {@link DiagnoseContext} for an exception entry. This is the SHARED
 * context builder reused by BOTH the on-demand diagnose endpoint and auto-mode —
 * it mirrors how the `new-exception` alert assembles its rich context (the
 * exception's own fields + the sibling request entry from the same batch), but
 * additionally collects the batch's recent query SQL (the queries leading up to
 * the failure are prime root-cause signal).
 *
 * Reads ONLY already-redacted stored content; SQL is taken without bindings, so
 * no query VALUES are ever handed to the diagnoser.
 *
 * @param storage    Where to read the exception's batch from.
 * @param entry      The exception (or client_exception) entry to diagnose.
 * @param occurrenceCount Times this family was seen in the window (>= 1).
 */
export async function buildDiagnoseContext(
  storage: StorageProvider,
  entry: Entry,
  occurrenceCount: number,
): Promise<DiagnoseContext> {
  const isClient = entry.type === EntryType.ClientException;
  const batch = await storage.batch(entry.batchId);
  const recentQueries = collectRecentQueries(batch);

  if (isClient) {
    const content = asPartialClientExceptionContent(entry.content);
    return {
      exceptionClass: typeof content.name === 'string' ? content.name : 'Error',
      message: typeof content.message === 'string' ? content.message : '',
      stack: typeof content.stack === 'string' ? content.stack : null,
      request: null,
      url: typeof content.url === 'string' ? content.url : null,
      userAgent: typeof content.userAgent === 'string' ? content.userAgent : null,
      recentQueries,
      client: true,
      occurrenceCount,
    };
  }

  const content = asPartialExceptionContent(entry.content);
  const request = findSiblingRequest(batch);
  const requestContent = request === null ? null : asPartialRequestContent(request.content);
  return {
    exceptionClass: typeof content.class === 'string' ? content.class : 'Error',
    message: typeof content.message === 'string' ? content.message : '',
    stack: typeof content.stack === 'string' ? content.stack : null,
    request: {
      route:
        requestContent !== null && typeof requestContent.uri === 'string'
          ? requestContent.uri
          : null,
      method:
        requestContent !== null && typeof requestContent.method === 'string'
          ? requestContent.method
          : null,
      statusCode:
        requestContent !== null && typeof requestContent.statusCode === 'number'
          ? requestContent.statusCode
          : null,
      durationMs: request?.durationMs ?? null,
    },
    url: null,
    userAgent: null,
    recentQueries,
    client: false,
    occurrenceCount,
  };
}

/** The sibling REQUEST entry in the batch (or `null`). */
function findSiblingRequest(batch: Entry[]): Entry | null {
  return batch.find((member) => member.type === EntryType.Request) ?? null;
}

/**
 * Collect the batch's query SQL, newest-last, SQL-only and clipped: take the most
 * recent {@link RECENT_QUERY_LIMIT} queries by `sequence`, drop bindings, and cap
 * each statement's length. Bindings are intentionally excluded so query VALUES
 * never reach the diagnoser.
 */
function collectRecentQueries(batch: Entry[]): string[] {
  const queries = batch
    .filter((member) => member.type === EntryType.Query)
    .sort((a, b) => a.sequence - b.sequence);
  const recent = queries.slice(-RECENT_QUERY_LIMIT);
  const sql: string[] = [];
  for (const query of recent) {
    const content = asPartialQueryContent(query.content);
    if (typeof content.sql === 'string' && content.sql !== '') {
      sql.push(clipSql(content.sql));
    }
  }
  return sql;
}

/** Clip an over-long SQL string, preserving its leading shape for the model. */
function clipSql(sql: string): string {
  if (sql.length <= QUERY_SQL_CHAR_LIMIT) return sql;
  return `${sql.slice(0, QUERY_SQL_CHAR_LIMIT)}…`;
}

/** A non-null object as a string-keyed record (else `{}`), read without a cast. */
function asContentRecord(content: unknown): Record<string, unknown> {
  return typeof content === 'object' && content !== null ? { ...content } : {};
}

function asPartialExceptionContent(content: unknown): Partial<ExceptionContent> {
  const record = asContentRecord(content);
  return {
    ...(typeof record.class === 'string' ? { class: record.class } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(typeof record.stack === 'string' ? { stack: record.stack } : {}),
  };
}

function asPartialClientExceptionContent(content: unknown): Partial<ClientExceptionContent> {
  const record = asContentRecord(content);
  return {
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(typeof record.stack === 'string' ? { stack: record.stack } : {}),
    ...(typeof record.url === 'string' ? { url: record.url } : {}),
    ...(typeof record.userAgent === 'string' ? { userAgent: record.userAgent } : {}),
  };
}

function asPartialRequestContent(content: unknown): Partial<RequestContent> {
  const record = asContentRecord(content);
  return {
    ...(typeof record.uri === 'string' ? { uri: record.uri } : {}),
    ...(typeof record.method === 'string' ? { method: record.method } : {}),
    ...(typeof record.statusCode === 'number' ? { statusCode: record.statusCode } : {}),
  };
}

function asPartialQueryContent(content: unknown): Partial<QueryContent> {
  const record = asContentRecord(content);
  return {
    ...(typeof record.sql === 'string' ? { sql: record.sql } : {}),
  };
}
