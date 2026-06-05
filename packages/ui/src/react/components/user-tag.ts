/**
 * The `user:<id>` tag is emitted by the core `userTagger` for request entries
 * carrying an authenticated user. These helpers let the UI pivot from a single
 * entry to "all activity for this user" by reusing the existing tag filter — the
 * entries page seeds its tag filter from a `?tag=` query param (same mechanism
 * as `?familyHash=`), so a link there filters the all-types list by the tag.
 */

const USER_TAG_PREFIX = 'user:';

/** The first `user:<id>` tag on an entry's tags, or null when none is present. */
export function findUserTag(tags: readonly string[]): string | null {
  for (const tag of tags) {
    if (tag.startsWith(USER_TAG_PREFIX) && tag.length > USER_TAG_PREFIX.length) return tag;
  }
  return null;
}

/** The display id (`<id>`) of a `user:<id>` tag — what comes after the prefix. */
export function userTagId(userTag: string): string {
  return userTag.slice(USER_TAG_PREFIX.length);
}

/** Hash-router href to the all-types entries list filtered by a `user:<id>` tag. */
export function buildUserActivityHref(userTag: string): string {
  return `#/entries?tag=${encodeURIComponent(userTag)}`;
}

/** The fixed prefix the dedicated User filter narrows the tag search to. */
export const USER_TAG_FILTER_PREFIX = USER_TAG_PREFIX;

/**
 * True when `tag` is a populated `user:<id>` tag — i.e. the active tag filter is
 * really a user pivot and should render in the User control, not the generic
 * tag chip. A bare `user:` (no id) is NOT a user filter.
 */
export function isUserTag(tag: string): boolean {
  return tag.startsWith(USER_TAG_PREFIX) && tag.length > USER_TAG_PREFIX.length;
}

/**
 * Prepends the `user:` prefix to a raw user id to form the underlying tag the
 * entries query filters by. Idempotent: an already-prefixed value passes
 * through unchanged, so the autocomplete (which surfaces full `user:<id>` tags)
 * and a hand-typed bare id both resolve to the same tag.
 */
export function toUserTag(idOrTag: string): string {
  return idOrTag.startsWith(USER_TAG_PREFIX) ? idOrTag : `${USER_TAG_PREFIX}${idOrTag}`;
}
