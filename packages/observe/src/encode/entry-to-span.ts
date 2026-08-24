import type { Entry } from '@dudousxd/nestjs-telescope';
import { EntryType } from '@dudousxd/nestjs-telescope';
import type { WireSpan } from '../wire/telemetry-wire.js';
import { entryStartMs } from './entry-start.js';
import {
  type WireTags,
  asRecord,
  finiteNumber,
  nonEmptyString,
  putTag,
  tagsOrUndefined,
  truncateTagValue,
} from './tag-values.js';
import { toWireError } from './wire-error.js';

interface SpanShape {
  name: string;
  tags: WireTags;
  className?: string;
  methodKey?: string;
}

/** Whitespace-collapsed SQL, capped like any other tag. Bindings never come along. */
function sqlShape(sql: unknown): string | undefined {
  const text = nonEmptyString(sql);
  return text === undefined ? undefined : truncateTagValue(text.replace(/\s+/g, ' ').trim());
}

/**
 * The per-type span shape. Tags carry only dimensions worth grouping by, and
 * never the values a query, cache, request or mail actually moved — this
 * payload leaves the process for a third-party collector, so SQL bindings,
 * cache values, cache keys, request/job payloads, mail bodies and recipients
 * are all deliberately absent.
 */
function shapeFor(entry: Entry, content: Record<string, unknown> | null): SpanShape {
  const fallback = `telescope.${entry.type}`;
  const tags: WireTags = {};
  if (content === null) return { name: fallback, tags };

  switch (entry.type) {
    case EntryType.Query: {
      putTag(tags, 'connection', content.connection);
      putTag(tags, 'slow', content.slow);
      putTag(tags, 'sql', sqlShape(content.sql));
      const connection = nonEmptyString(content.connection);
      // The connection is the closest thing a query has to an owning class, and
      // it is what makes Observe's per-class view separate read from write pools.
      return {
        name: 'db.query',
        tags,
        ...(connection !== undefined ? { className: connection } : {}),
      };
    }
    case EntryType.Cache: {
      const operation = nonEmptyString(content.operation);
      putTag(tags, 'operation', operation);
      putTag(tags, 'hit', content.hit);
      putTag(tags, 'tier', content.tier);
      putTag(tags, 'stale', content.stale);
      putTag(tags, 'store', content.store);
      return { name: operation === undefined ? fallback : `cache.${operation}`, tags };
    }
    case EntryType.Redis: {
      const command = nonEmptyString(content.command);
      putTag(tags, 'command', command);
      return { name: command === undefined ? fallback : `redis.${command}`, tags };
    }
    case EntryType.HttpClient: {
      putTag(tags, 'method', content.method);
      putTag(tags, 'host', content.host);
      putTag(tags, 'statusCode', content.statusCode);
      return { name: 'http.client', tags };
    }
    case EntryType.Mail: {
      putTag(tags, 'mailer', content.mailer);
      putTag(tags, 'status', content.status);
      return { name: 'mail.send', tags };
    }
    case EntryType.Model: {
      const action = nonEmptyString(content.action);
      const entity = nonEmptyString(content.entity);
      putTag(tags, 'action', action);
      putTag(tags, 'entity', entity);
      return {
        name: action === undefined ? fallback : `model.${action}`,
        tags,
        ...(entity !== undefined ? { className: entity } : {}),
        ...(action !== undefined ? { methodKey: action } : {}),
      };
    }
    case EntryType.Event: {
      const name = nonEmptyString(content.name);
      putTag(tags, 'listeners', content.listenerCount);
      return { name: name === undefined ? fallback : `event.${name}`, tags };
    }
    case EntryType.Job: {
      putTag(tags, 'queue', content.queue);
      putTag(tags, 'job', content.name);
      putTag(tags, 'status', content.status);
      return { name: fallback, tags };
    }
    case EntryType.Log: {
      putTag(tags, 'level', content.level);
      return { name: fallback, tags };
    }
    default:
      return { name: fallback, tags };
  }
}

/**
 * One Telescope entry as an Observe span. `so` is what lets the dashboard draw
 * overlapping bars, so it is measured against the ROOT's start, not the batch's.
 * `ch` is never set: Telescope records a batch as a flat stream, so every span
 * sits one level under its snapshot and `ch: []` would only pad the payload.
 */
/**
 * The collector requires `c` and `m` on every span and caps both at 255. Their
 * own SDK always has them because every span it makes is a proxied provider
 * method; Telescope's watchers often have no owning class at all, so the span
 * name — already written as `<subject>.<operation>` — supplies the pair.
 */
const MAX_IDENTIFIER_LENGTH = 255;

function clampIdentifier(value: string): string {
  return value.length <= MAX_IDENTIFIER_LENGTH ? value : value.slice(0, MAX_IDENTIFIER_LENGTH);
}

function splitQualifiedName(name: string): { className: string; methodKey: string } {
  const cut = name.lastIndexOf('.');
  if (cut <= 0 || cut === name.length - 1) {
    return { className: 'telescope', methodKey: name };
  }
  return { className: name.slice(0, cut), methodKey: name.slice(cut + 1) };
}

export function entryToSpan(entry: Entry, rootStartMs: number): WireSpan {
  const content = asRecord(entry.content);
  const { name, tags, className, methodKey } = shapeFor(entry, content);

  const duration = finiteNumber(entry.durationMs);
  const spanId = nonEmptyString(entry.spanId);
  const startedAtMs = entryStartMs(entry);
  const startOffset =
    Number.isFinite(startedAtMs) && Number.isFinite(rootStartMs)
      ? Math.max(0, startedAtMs - rootStartMs)
      : undefined;
  const error = toWireError(entry);
  const spanTags = tagsOrUndefined(tags);
  const qualified = splitQualifiedName(name);

  return {
    n: name,
    o: 'auto',
    ...(spanTags !== undefined ? { t: spanTags } : {}),
    ...(duration !== undefined ? { d: duration } : {}),
    ...(error !== null ? { e: error } : {}),
    c: clampIdentifier(className ?? qualified.className),
    m: clampIdentifier(methodKey ?? qualified.methodKey),
    ...(spanId !== undefined ? { s: spanId } : {}),
    ...(startOffset !== undefined ? { so: startOffset } : {}),
  };
}
