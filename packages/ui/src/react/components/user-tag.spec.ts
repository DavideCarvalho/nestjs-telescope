import { describe, expect, it } from 'vitest';
import { buildUserActivityHref, findUserTag, isUserTag, toUserTag, userTagId } from './user-tag.js';

describe('findUserTag', () => {
  it('returns the first user:<id> tag', () => {
    expect(findUserTag(['slow', 'user:42', 'status:200'])).toBe('user:42');
  });

  it('returns null when no user tag is present', () => {
    expect(findUserTag(['slow', 'status:500'])).toBeNull();
    expect(findUserTag([])).toBeNull();
  });

  it('ignores a bare prefix with no id', () => {
    expect(findUserTag(['user:'])).toBeNull();
  });
});

describe('userTagId', () => {
  it('strips the prefix to yield the display id', () => {
    expect(userTagId('user:42')).toBe('42');
    expect(userTagId('user:a@b.com')).toBe('a@b.com');
  });
});

describe('buildUserActivityHref', () => {
  it('links to the all-types entries list filtered by the tag', () => {
    expect(buildUserActivityHref('user:42')).toBe('#/entries?tag=user%3A42');
  });

  it('url-encodes special characters in the id', () => {
    expect(buildUserActivityHref('user:a@b.com')).toBe('#/entries?tag=user%3Aa%40b.com');
  });
});

describe('isUserTag', () => {
  it('recognizes a populated user:<id> tag (so the User control claims it)', () => {
    expect(isUserTag('user:42')).toBe(true);
    expect(isUserTag('user:a@b.com')).toBe(true);
  });

  it('rejects non-user tags and a bare prefix', () => {
    expect(isUserTag('slow')).toBe(false);
    expect(isUserTag('status:500')).toBe(false);
    expect(isUserTag('user:')).toBe(false);
    expect(isUserTag('')).toBe(false);
  });
});

describe('toUserTag', () => {
  it('prefixes a bare id to form the underlying tag', () => {
    expect(toUserTag('42')).toBe('user:42');
    expect(toUserTag('a@b.com')).toBe('user:a@b.com');
  });

  it('is idempotent on an already-prefixed value', () => {
    expect(toUserTag('user:42')).toBe('user:42');
  });
});
