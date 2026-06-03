import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CacheBadge, cacheBadge } from './cache-badge.js';

describe('cacheBadge', () => {
  it('returns a green HIT for a successful read', () => {
    const badge = cacheBadge({ operation: 'get', hit: true, key: 'user:1' });
    expect(badge?.label).toBe('HIT');
    expect(badge?.className).toContain('emerald');
  });

  it('returns an amber MISS for a failed read', () => {
    const badge = cacheBadge({ operation: 'get', hit: false, key: 'user:1' });
    expect(badge?.label).toBe('MISS');
    expect(badge?.className).toContain('amber');
  });

  it('returns a neutral SET for a write', () => {
    const badge = cacheBadge({ operation: 'set', hit: null, key: 'user:1' });
    expect(badge?.label).toBe('SET');
    expect(badge?.className).toContain('zinc');
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
