import type { ClientExceptionContent, Entry, ExceptionContent } from '@dudousxd/nestjs-telescope';
import { EntryType } from '@dudousxd/nestjs-telescope';
import type { WireError } from '../wire/telemetry-wire.js';
import { type WireTags, asRecord, nonEmptyString, putTag, tagsOrUndefined } from './tag-values.js';

/** How many `ExceptionContent.context` keys may reach the wire. */
const MAX_CONTEXT_TAGS = 8;

/**
 * True for the two entry types that ARE a failure by construction. A `failed`
 * tag is not enough on its own: a failed job or a 500 request carries one too,
 * and those become records in their own right rather than a `WireError`.
 */
export function isFailureEntry(entry: Entry): boolean {
  return entry.type === EntryType.Exception || entry.type === EntryType.ClientException;
}

function serverError(content: ExceptionContent): WireError | null {
  const message = nonEmptyString(content.message) ?? nonEmptyString(content.class);
  if (message === undefined) return null;

  const tags: WireTags = {};
  const context = asRecord(content.context);
  if (context !== null) {
    for (const key of Object.keys(context).slice(0, MAX_CONTEXT_TAGS)) {
      putTag(tags, key, context[key]);
    }
  }

  const cls = nonEmptyString(content.class);
  const stack = nonEmptyString(content.stack);
  return {
    message,
    ...(cls !== undefined ? { cls } : {}),
    ...(stack !== undefined ? { stack } : {}),
    ...(tagsOrUndefined(tags) !== undefined ? { tags } : {}),
  };
}

function browserError(content: ClientExceptionContent): WireError | null {
  const message = nonEmptyString(content.message) ?? nonEmptyString(content.name);
  if (message === undefined) return null;

  // The page URL is a browser error's route, and the release is what tells a
  // deploy-shaped spike apart from a real regression. `componentStack` and
  // `extra` stay out: unbounded, and `extra` is host-defined content.
  const tags: WireTags = {};
  putTag(tags, 'url', content.url);
  putTag(tags, 'release', content.release);
  putTag(tags, 'userAgent', content.userAgent);

  const cls = nonEmptyString(content.name);
  const stack = nonEmptyString(content.stack);
  return {
    message,
    ...(cls !== undefined ? { cls } : {}),
    ...(stack !== undefined ? { stack } : {}),
    ...(tagsOrUndefined(tags) !== undefined ? { tags } : {}),
  };
}

/**
 * The `WireError` for a failure entry, or null when the entry is not a failure
 * (or carries nothing nameable). `class`/`name` both land on `cls`, which is
 * what Observe groups errors by.
 */
export function toWireError(entry: Entry): WireError | null {
  const content = asRecord(entry.content);
  if (content === null) return null;
  if (entry.type === EntryType.Exception) {
    return serverError(content as unknown as ExceptionContent);
  }
  if (entry.type === EntryType.ClientException) {
    return browserError(content as unknown as ClientExceptionContent);
  }
  return null;
}
