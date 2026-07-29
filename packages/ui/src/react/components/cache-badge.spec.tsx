import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CacheBadge, cacheBadge } from './cache-badge.js';

describe('cacheBadge', () => {
  it('returns a `good` HIT for a successful read', () => {
    const badge = cacheBadge({ operation: 'get', hit: true, key: 'user:1' });
    expect(badge?.label).toBe('HIT');
    expect(badge?.variant).toBe('good');
  });

  it('returns a `warn` MISS for a failed read', () => {
    const badge = cacheBadge({ operation: 'get', hit: false, key: 'user:1' });
    expect(badge?.label).toBe('MISS');
    expect(badge?.variant).toBe('warn');
  });

  it('returns a neutral SET for a write', () => {
    const badge = cacheBadge({ operation: 'set', hit: null, key: 'user:1' });
    expect(badge?.label).toBe('SET');
    expect(badge?.variant).toBe('muted');
  });

  it('labels delete and clear operations', () => {
    expect(cacheBadge({ operation: 'delete', hit: null, key: 'k' })?.label).toBe('DEL');
    expect(cacheBadge({ operation: 'clear', hit: null, key: 'k' })?.label).toBe('CLEAR');
  });

  it('marks a grace-served hit as stale (warn) and appends the tier', () => {
    const stale = cacheBadge({ operation: 'get', hit: true, key: 'k', stale: true, tier: 'l2' });
    expect(stale?.label).toBe('HIT·STALE L2');
    expect(stale?.variant).toBe('warn');

    const fresh = cacheBadge({ operation: 'get', hit: true, key: 'k', tier: 'l1' });
    expect(fresh?.label).toBe('HIT L1');
    expect(fresh?.variant).toBe('good');
  });

  it('returns null for non-cache content', () => {
    expect(cacheBadge({ sql: 'select 1' })).toBeNull();
    expect(cacheBadge(null)).toBeNull();
    expect(cacheBadge({ operation: 'get', hit: 'yes', key: 'k' })).toBeNull();
  });
});

describe('CacheBadge', () => {
  it('renders the label for a cache read', () => {
    render(<CacheBadge content={{ operation: 'get', hit: true, key: 'user:1' }} />);
    expect(screen.getByText('HIT')).toBeTruthy();
  });

  it('renders nothing for non-cache content', () => {
    const { container } = render(<CacheBadge content={{ sql: 'select 1' }} />);
    expect(container.firstChild).toBeNull();
  });
});
