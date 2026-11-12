import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TELESCOPE_ACCESS_DENIED_EVENT } from '../client/index.js';
import { AccessGate } from './access-denied.js';

function deny(detail: object): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(TELESCOPE_ACCESS_DENIED_EVENT, { detail }));
  });
}

describe('AccessGate', () => {
  it('renders the dashboard until access is denied, then the access-denied screen', () => {
    render(
      <AccessGate>
        <p>dashboard</p>
      </AccessGate>,
    );
    expect(screen.getByText('dashboard')).toBeTruthy();
    deny({ status: 403, reason: 'forbidden' });
    expect(screen.queryByText('dashboard')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Access denied');
  });

  it('asks to sign in on a 401 without redirectTo', () => {
    render(
      <AccessGate>
        <p>dashboard</p>
      </AccessGate>,
    );
    deny({ status: 401, reason: 'unauthenticated' });
    expect(screen.getByRole('alert').textContent).toContain('Sign in required');
  });
});
