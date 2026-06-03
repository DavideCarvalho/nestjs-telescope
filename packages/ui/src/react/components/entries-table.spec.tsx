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
});
