import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../../client/index.js';
import { entryLabel } from './entries-table.js';
import { ENTRY_TYPES } from './entry-types.js';
import { OfficialEventBody, officialEventLabel } from './official-event.js';

function entry(type: string, content: unknown): Entry {
  return {
    id: 'e1',
    type,
    batchId: 'b',
    familyHash: null,
    content,
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: '2026-11-07T12:00:00Z',
  };
}

describe('official event labels', () => {
  it('labels resilience, workflow and auth entries by event and subject', () => {
    expect(
      officialEventLabel('resilience', { event: 'retry', policy: 'orders', source: 'A.b' }),
    ).toBe('retry orders · A.b');
    expect(
      officialEventLabel('workflow', { event: 'step-failed', workflow: 'ship', step: 'charge' }),
    ).toBe('step-failed ship › charge');
    expect(
      officialEventLabel('auth', { source: 'authentication', event: 'sign-in', userId: 'u1' }),
    ).toBe('sign-in u1');
    expect(
      officialEventLabel('auth', {
        source: 'authorization',
        event: 'denied',
        policy: 'OrderPolicy',
        ability: 'refund',
        reason: 'forbidden',
      }),
    ).toBe('denied OrderPolicy.refund (forbidden)');
    expect(
      officialEventLabel('auth', { source: 'authorization', event: 'denied', policy: null }),
    ).toBe('denied no check declared');
    expect(officialEventLabel('workflow', null)).toBe('workflow unknown');
  });

  it('the entries table uses them, and labels mail by status and subject', () => {
    expect(entryLabel(entry('resilience', { event: 'timeout', policy: 'p' }))).toBe('timeout p');
    expect(entryLabel(entry('mail', { status: 'sent', subject: 'Welcome' }))).toBe(
      '[sent] Welcome',
    );
  });

  it('the nav knows the three types', () => {
    const ids = ENTRY_TYPES.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['resilience', 'workflow', 'auth']));
  });
});

describe('OfficialEventBody', () => {
  it('renders the event badge, subject, scalar fields and the error', () => {
    render(
      <OfficialEventBody
        type="workflow"
        content={{
          event: 'step-failed',
          workflow: 'ship',
          step: 'charge',
          attempt: 2,
          error: { name: 'StepFailedError', message: 'card declined' },
        }}
      />,
    );
    expect(screen.getByText('step-failed').className).toContain('text-bad');
    expect(screen.getByText('ship › charge')).toBeTruthy();
    expect(screen.getByText('attempt')).toBeTruthy();
    expect(screen.getByText(/card declined/)).toBeTruthy();
  });

  it('renders an auth entry with its source and redacted refs', () => {
    render(
      <OfficialEventBody
        type="auth"
        content={{
          source: 'authentication',
          event: 'sign-in',
          userId: 'u1',
          sessionRef: 'sha256:abcdef123456',
          metadataKeys: ['ip'],
        }}
      />,
    );
    expect(screen.getByText('sign-in').className).toContain('text-brand');
    expect(screen.getByText('@nestjs/authentication')).toBeTruthy();
    expect(screen.getByText('sha256:abcdef123456')).toBeTruthy();
    expect(screen.getByText('ip')).toBeTruthy();
  });

  it('survives garbage content', () => {
    render(<OfficialEventBody type="resilience" content="nope" />);
    expect(screen.getByTestId('official-event')).toBeTruthy();
  });
});
