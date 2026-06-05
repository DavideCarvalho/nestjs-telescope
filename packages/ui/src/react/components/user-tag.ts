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
