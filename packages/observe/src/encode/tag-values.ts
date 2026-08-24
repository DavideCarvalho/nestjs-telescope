/**
 * Tag plumbing shared by the encoders. Observe's tag maps are a query dimension,
 * not a payload: only scalars are on the wire, every string is capped, and an
 * empty map is never emitted (their collector allowlists keys, and `{}` is pure
 * overhead on a per-record billed ingest).
 */

export type WireTags = Record<string, string | number | boolean>;

/** Ceiling for any string that reaches a tag map. */
export const MAX_TAG_LENGTH = 512;

export function truncateTagValue(value: string): string {
  return value.length <= MAX_TAG_LENGTH ? value : `${value.slice(0, MAX_TAG_LENGTH - 1)}…`;
}

/**
 * Record `value` under `key` when it is a usable scalar. Anything else — an
 * object, an array, a function, null/undefined, NaN — is dropped rather than
 * stringified, so a nested payload can never be flattened onto the wire.
 */
export function putTag(tags: WireTags, key: string, value: unknown): void {
  if (typeof value === 'string') {
    if (value.length > 0) tags[key] = truncateTagValue(value);
    return;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) tags[key] = value;
    return;
  }
  if (typeof value === 'boolean') tags[key] = value;
}

/** The map itself, or undefined when nothing survived. */
export function tagsOrUndefined(tags: WireTags): WireTags | undefined {
  return Object.keys(tags).length > 0 ? tags : undefined;
}

/**
 * Telescope tags are a flat string list in two shapes: `key:value`
 * (`status:200`, `queue:emails`) and bare markers (`slow`, `failed`). Split on
 * the FIRST colon only, because values legitimately contain more
 * (`schedule:cron`, `job:orders:reindex`).
 */
export function parseEntryTags(tags: readonly string[], skip: (key: string) => boolean): WireTags {
  const parsed: WireTags = {};
  for (const tag of tags) {
    if (tag.length === 0) continue;
    const separator = tag.indexOf(':');
    const key = separator === -1 ? tag : tag.slice(0, separator);
    if (key.length === 0 || skip(key)) continue;
    if (separator === -1) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = truncateTagValue(tag.slice(separator + 1));
  }
  return parsed;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
