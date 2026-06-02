import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
});
