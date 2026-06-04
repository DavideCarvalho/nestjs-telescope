import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AuthMeResult, LoginResult, TelescopeClient } from '../client/index.js';
import { TelescopeProvider } from '../react/index.js';
import { AuthProvider } from './auth-context.js';
import { AuthScreen } from './auth-screen.js';

interface AuthStubs {
  me?: () => Promise<AuthMeResult>;
  login?: (username: string, password: string) => Promise<LoginResult>;
  logout?: () => Promise<void>;
}

/** A client whose only working surface is `auth`; the rest throws if touched. */
function authClient(stubs: AuthStubs = {}): TelescopeClient {
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  return {
    entries: unused,
    entry: unused,
    pulse: unused,
    queues: unused,
    timeseries: unused,
    stats: unused,
    tags: unused,
    meta: unused,
    serverStats: unused,
    health: unused,
    liveQueues: unused,
    schedulesLive: unused,
    queueCounts: unused,
    queueJobs: unused,
    queueJob: unused,
    queueJobAction: unused,
    queueAction: unused,
    queueEnqueue: unused,
    auth: {
      me: stubs.me ?? (async () => ({ status: 'unauthenticated', modes: ['login'] })),
      login: stubs.login ?? (async () => ({ ok: true })),
      logout: stubs.logout ?? (async () => {}),
    },
  };
}

function renderScreen(client: TelescopeClient, modes: ('session' | 'login')[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AuthScreen modes={modes} />
        </AuthProvider>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('AuthScreen — login mode', () => {
  it('renders the username/password form with a Sign in button', () => {
    renderScreen(authClient(), ['login']);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy();
    expect(document.querySelector('input[name="username"]')).toBeTruthy();
    expect(document.querySelector('input[name="password"]')).toBeTruthy();
  });

  it('submits the entered credentials to auth.login', async () => {
    const login = vi.fn(async () => ({ ok: true }) as LoginResult);
    renderScreen(authClient({ login }), ['login']);
    fireEvent.change(document.querySelector('input[name="username"]')!, {
      target: { value: 'ops' },
    });
    fireEvent.change(document.querySelector('input[name="password"]')!, {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('ops', 'secret'));
  });

  it('shows an inline error when login fails', async () => {
    const login = vi.fn(async () => ({ ok: false, message: 'Invalid credentials' }) as LoginResult);
    renderScreen(authClient({ login }), ['login']);
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Invalid credentials'));
  });
});

describe('AuthScreen — session-only mode', () => {
  it('renders the instruction card with a Retry button (no login form)', () => {
    renderScreen(authClient(), ['session']);
    expect(screen.getByText(/open telescope from your application/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(document.querySelector('input[name="password"]')).toBeNull();
  });

  it('re-runs auth.me when Retry is clicked', async () => {
    const me = vi.fn(
      async () => ({ status: 'unauthenticated', modes: ['session'] }) as AuthMeResult,
    );
    renderScreen(authClient({ me }), ['session']);
    await waitFor(() => expect(me).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(me).toHaveBeenCalledTimes(2));
  });
});
