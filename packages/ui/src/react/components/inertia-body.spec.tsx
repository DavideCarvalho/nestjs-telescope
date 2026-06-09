import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InertiaBody } from './inertia-body.js';

function content(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    component: 'Dashboard',
    method: 'GET',
    url: '/dashboard',
    statusCode: 200,
    isPartial: false,
    versionMismatch: false,
    assetVersion: 'v1',
    clientVersion: null,
    encryptHistory: false,
    clearHistory: false,
    pageBytes: 2048,
    ssr: false,
    partial: { only: [], except: [], reset: [], resetOnce: [] },
    props: {
      sharedKeys: [],
      finalKeys: ['user'],
      deferred: {},
      merge: [],
      deepMerge: [],
      matchPropsOn: {},
      optionalKeys: [],
      onceKeys: [],
      excludedKeys: [],
    },
    resolvedProps: { user: { name: 'Ada' } },
    ...over,
  };
}

describe('InertiaBody', () => {
  it('renders the component header and resolved props tree', () => {
    render(<InertiaBody content={content()} />);
    expect(screen.getByText('Dashboard')).toBeTruthy();
    expect(screen.getByText('/dashboard')).toBeTruthy();
    // resolved props JSON shows the user prop
    expect(screen.getByText(/"name": "Ada"/)).toBeTruthy();
  });

  it('renders the version-mismatch red callout', () => {
    render(
      <InertiaBody
        content={content({
          statusCode: 409,
          versionMismatch: true,
          clientVersion: 'old',
          assetVersion: 'v1',
        })}
      />,
    );
    expect(screen.getByText(/Version mismatch/)).toBeTruthy();
    expect(screen.getByText('old')).toBeTruthy();
  });

  it('renders the partial-reload Kept and Excluded columns', () => {
    render(
      <InertiaBody
        content={content({
          isPartial: true,
          partial: { only: ['keepMe'], except: ['dropMe'], reset: [], resetOnce: [] },
          props: { ...(content().props as object), excludedKeys: ['alsoDropped'] },
        })}
      />,
    );
    expect(screen.getByText('Kept')).toBeTruthy();
    expect(screen.getByText('Excluded')).toBeTruthy();
    expect(screen.getByText('keepMe')).toBeTruthy();
    expect(screen.getByText('dropMe')).toBeTruthy();
    expect(screen.getByText('alsoDropped')).toBeTruthy();
  });

  it('renders deferred groups as group → dotPaths', () => {
    render(
      <InertiaBody
        content={content({
          props: { ...(content().props as object), deferred: { default: ['user.stats'] } },
        })}
      />,
    );
    expect(screen.getByText('default:')).toBeTruthy();
    expect(screen.getByText('user.stats')).toBeTruthy();
  });

  it('renders history flag chips and SSR state', () => {
    render(
      <InertiaBody content={content({ encryptHistory: true, clearHistory: true, ssr: true })} />,
    );
    expect(screen.getByText('encryptHistory: on')).toBeTruthy();
    expect(screen.getByText('clearHistory: on')).toBeTruthy();
    expect(screen.getByText('SSR: yes')).toBeTruthy();
  });

  it('reads fields defensively for malformed content', () => {
    const { container } = render(<InertiaBody content={{}} />);
    expect(container).toBeTruthy();
  });
});
