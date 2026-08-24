import type { Entry, LogContent } from '@dudousxd/nestjs-telescope';
import { EntryType } from '@dudousxd/nestjs-telescope';
import type { WireLog } from '../wire/telemetry-wire.js';
import { asRecord, nonEmptyString } from './tag-values.js';

/** Ceiling on a forwarded log line. */
export const MAX_LOG_TEXT_LENGTH = 4096;

const TRUNCATION_MARKER = '… [truncated]';

function capText(message: string): string {
  if (message.length <= MAX_LOG_TEXT_LENGTH) return message;
  return `${message.slice(0, MAX_LOG_TEXT_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/**
 * One `log` entry as an Observe log line, or null for any other entry. This is
 * the one wire section with long key names.
 */
export function encodeLog(entry: Entry): WireLog | null {
  if (entry.type !== EntryType.Log) return null;
  const raw = asRecord(entry.content);
  if (raw === null) return null;
  const content = raw as unknown as LogContent;

  const message = nonEmptyString(content.message);
  if (message === undefined) return null;

  const timestamp = entry.createdAt.getTime();
  if (!Number.isFinite(timestamp)) return null;

  const level = nonEmptyString(content.level)?.toLowerCase();
  const context = nonEmptyString(content.context);
  // Same fallback the snapshot uses for `ti`: without an OTel provider every
  // entry's `traceId` is null, and a log with no trace id cannot be shown
  // against the request that emitted it. The batch id identifies the operation
  // just as well, and the two agree because they come from the same entry.
  const traceId = nonEmptyString(entry.traceId) ?? nonEmptyString(entry.batchId);
  const spanId = nonEmptyString(entry.spanId);

  return {
    timestamp,
    text: capText(message),
    ...(traceId !== undefined ? { traceId } : {}),
    ...(spanId !== undefined ? { spanId } : {}),
    ...(level !== undefined ? { level } : {}),
    ...(context !== undefined ? { context } : {}),
  };
}
