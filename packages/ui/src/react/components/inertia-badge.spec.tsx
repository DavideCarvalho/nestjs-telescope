import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InertiaBadge, humanBytes, inertiaBadges } from './inertia-badge.js';

function content(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    component: 'Dashboard',
    isPartial: false,
    versionMismatch: false,
    pageBytes: 2048,
    props: { deferred: {} },
    ...over,
  };
}

describe('inertiaBadges', () => {
  it('returns a red 409 chip on version mismatch', () => {
    const badges = inertiaBadges(content({ versionMismatch: true }));
    const mismatch = badges.find((b) => b.label === '409');
    expect(mismatch).toBeDefined();
    expect(mismatch?.className).toContain('red');
  });

  it('returns a partial chip for partial reloads', () => {
    const badges = inertiaBadges(content({ isPartial: true }));
    expect(badges.some((b) => b.label === 'partial')).toBe(true);
  });

  it('returns a deferred chip when there are deferred groups', () => {
    const badges = inertiaBadges(content({ props: { deferred: { default: ['stats'] } } }));
    expect(badges.some((b) => b.label === 'deferred')).toBe(true);
  });

  it('always includes a human page-size chip', () => {
    const badges = inertiaBadges(content({ pageBytes: 2048 }));
    expect(badges.some((b) => b.label === '2.0 KB')).toBe(true);
  });

  it('returns an empty list for non-inertia content', () => {
    expect(inertiaBadges({ sql: 'select 1' })).toEqual([]);
    expect(inertiaBadges(null)).toEqual([]);
  });
});

describe('humanBytes', () => {
  it('formats bytes, KB, and MB', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(2048)).toBe('2.0 KB');
    expect(humanBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(humanBytes(0)).toBe('0 B');
  });
});

describe('InertiaBadge', () => {
  it('renders chips for inertia content', () => {
    render(<InertiaBadge content={content({ versionMismatch: true, isPartial: true })} />);
    expect(screen.getByText('409')).toBeTruthy();
    expect(screen.getByText('partial')).toBeTruthy();
  });

  it('renders nothing for non-inertia content', () => {
    const { container } = render(<InertiaBadge content={{ sql: 'select 1' }} />);
    expect(container.firstChild).toBeNull();
  });
});
