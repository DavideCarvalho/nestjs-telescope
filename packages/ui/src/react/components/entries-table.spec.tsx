import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '../../client/index.js';
import { EntriesTable, entryLabel } from './entries-table.js';

function entry(over: Partial<Entry> & { type: string }): Entry {
  return {
    id: 'e1',
    batchId: 'b',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: 12,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: '2026-06-02T12:00:00Z',
    ...over,
  };
}

describe('EntriesTable', () => {
  it('derives a label by type', () => {
    expect(entryLabel(entry({ type: 'query', content: { sql: 'select 1' } }))).toBe('select 1');
    expect(entryLabel(entry({ type: 'request', content: { method: 'GET', uri: '/a' } }))).toBe(
      'GET /a',
    );
    expect(entryLabel(entry({ type: 'job', content: { queue: 'mail', name: 'send' } }))).toBe(
      'mail:send',
    );
    expect(entryLabel(entry({ type: 'exception', content: null }))).toBe('exception');
  });
  it('summarizes a dump by its label, falling back to a value preview', () => {
    expect(
      entryLabel(entry({ type: 'dump', content: { label: 'my-dump', value: { a: 1 } } })),
    ).toBe('my-dump');
    expect(entryLabel(entry({ type: 'dump', content: { label: null, value: { a: 1 } } }))).toBe(
      '{"a":1}',
    );
  });
  it('summarizes a model entry as "<action> <entity>#<id>"', () => {
    expect(
      entryLabel(entry({ type: 'model', content: { action: 'create', entity: 'User', id: '7' } })),
    ).toBe('create User#7');
    expect(
      entryLabel(entry({ type: 'model', content: { action: 'delete', entity: 'User', id: null } })),
    ).toBe('delete User');
  });
  it('summarizes a redis entry as "<COMMAND> <args-preview>"', () => {
    expect(
      entryLabel(entry({ type: 'redis', content: { command: 'GET', args: ['user:1'] } })),
    ).toBe('GET user:1');
    expect(entryLabel(entry({ type: 'redis', content: { command: 'PING', args: [] } }))).toBe(
      'PING',
    );
  });
  it('summarizes an inertia entry as "<METHOD> → <Component>" with a partial suffix', () => {
    expect(
      entryLabel(entry({ type: 'inertia', content: { component: 'Dashboard', method: 'GET' } })),
    ).toBe('GET → Dashboard');
    expect(
      entryLabel(
        entry({
          type: 'inertia',
          content: { component: 'Users', method: 'GET', isPartial: true },
        }),
      ),
    ).toBe('GET → Users (partial)');
  });
  it('renders rows with type + summary', () => {
    render(<EntriesTable entries={[entry({ type: 'query', content: { sql: 'select 1' } })]} />);
    expect(screen.getByText('query')).toBeTruthy();
    expect(screen.getByText('select 1')).toBeTruthy();
  });

  it('renders a trace affordance linking to the trace page when traceId is set', () => {
    render(
      <EntriesTable
        entries={[entry({ type: 'query', traceId: 'trace-abc123def', content: { sql: 'q' } })]}
      />,
    );
    const link = screen.getByRole('link', { name: /trace/i });
    expect(link.getAttribute('href')).toBe('#/traces/trace-abc123def');
  });

  it('does not render a trace affordance when traceId is null', () => {
    render(
      <EntriesTable entries={[entry({ type: 'query', traceId: null, content: { sql: 'q' } })]} />,
    );
    expect(screen.queryByRole('link', { name: /trace/i })).toBeNull();
  });

  it('does not trigger row select when the trace affordance is clicked', () => {
    const onSelect = vi.fn();
    render(
      <EntriesTable
        entries={[entry({ type: 'query', traceId: 'trace-xyz', content: { sql: 'q' } })]}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: /trace/i }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders a user pivot chip linking to the tag-filtered entries list', () => {
    render(
      <EntriesTable
        entries={[entry({ type: 'request', tags: ['user:42'], content: { uri: '/a' } })]}
      />,
    );
    const link = screen.getByRole('link', { name: 'user:42' });
    expect(link.getAttribute('href')).toBe('#/entries?tag=user%3A42');
  });

  it('does not render a user pivot chip when no user tag is present', () => {
    render(
      <EntriesTable
        entries={[entry({ type: 'request', tags: ['status:200'], content: { uri: '/a' } })]}
      />,
    );
    expect(screen.queryByRole('link', { name: /^user:/ })).toBeNull();
    // the non-user tag still renders as plain text
    expect(screen.getByText('status:200')).toBeTruthy();
  });

  it('does not trigger row select when the user pivot chip is clicked', () => {
    const onSelect = vi.fn();
    render(
      <EntriesTable
        entries={[entry({ type: 'request', tags: ['user:7'], content: { uri: '/a' } })]}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'user:7' }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
