import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HashRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AuthMeResult, LoginResult, TelescopeClient } from '../client/index.js';
import { TelescopeProvider, useTelescopeClient } from '../react/index.js';
import { AuthProvider, useAuth } from './auth-context.js';
import { AuthScreen } from './auth-screen.js';
import { DashboardLayout } from './dashboard-layout.js';
import { ThemeProvider } from './theme-context.js';

interface AuthStubs {
  me?: () => Promise<AuthMeResult>;
  login?: (username: string, password: string) => Promise<LoginResult>;
  logout?: () => Promise<void>;
}

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
      me: stubs.me ?? (async () => ({ status: 'disabled' })),
      login: stubs.login ?? (async () => ({ ok: true })),
      logout: stubs.logout ?? (async () => {}),
    },
  };
}

// A probe that runs a telescope query so we can drive a 401 mid-session.
function FailingProbe(): JSX.Element {
  const client = useTelescopeClient();
  useQuery({ queryKey: ['telescope', 'probe'], queryFn: () => client.entries(), retry: false });
  return <span>probe</span>;
}

// Mirrors App's AuthGate so the gating logic is exercised end-to-end.
function Gate(): JSX.Element {
  const { phase, modes } = useAuth();
  if (phase === 'loading') return <div data-testid="auth-loading" />;
  if (phase === 'screen') return <AuthScreen modes={modes} />;
  return (
    <HashRouter>
      <DashboardLayout>
        <FailingProbe />
      </DashboardLayout>
    </HashRouter>
  );
}

function renderGate(client: TelescopeClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <TelescopeProvider client={client}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <Gate />
          </AuthProvider>
        </QueryClientProvider>
      </TelescopeProvider>
    </ThemeProvider>,
  );
}

describe('auth boot gate', () => {
  it('disabled mode renders the app with no Sign out button', async () => {
    renderGate(authClient({ me: async () => ({ status: 'disabled' }) }));
    await waitFor(() => expect(screen.getByText('probe')).toBeTruthy());
    expect(screen.getByText('Overview')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
  });

  it('authenticated mode renders the app with a Sign out button', async () => {
    renderGate(authClient({ me: async () => ({ status: 'authenticated', user: { id: 'ops' } }) }));
    await waitFor(() => expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy());
    expect(screen.getByText('probe')).toBeTruthy();
  });

  it('unauthenticated mode renders the AuthScreen instead of the app', async () => {
    renderGate(authClient({ me: async () => ({ status: 'unauthenticated', modes: ['login'] }) }));
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy());
    expect(screen.queryByText('probe')).toBeNull();
  });

  it('logout clears the session and flips back to the AuthScreen', async () => {
    let authed = true;
    const logout = vi.fn(async () => {
      authed = false;
    });
    renderGate(
      authClient({
        me: async () =>
          authed
            ? { status: 'authenticated', user: { id: 'ops' } }
            : { status: 'unauthenticated', modes: ['login'] },
        logout,
      }),
    );
    const signOut = await screen.findByRole('button', { name: /sign out/i });
    fireEvent.click(signOut);
    await waitFor(() => expect(logout).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy());
  });

  it('a 401 from an API call mid-session flips back to the AuthScreen', async () => {
    let authed = true;
    const me = vi.fn(
      async (): Promise<AuthMeResult> =>
        authed
          ? { status: 'authenticated', user: { id: 'ops' } }
          : { status: 'unauthenticated', modes: ['login'] },
    );
    const client = authClient({ me });
    // The probe query throws a 401-shaped error, like the real `get` helper.
    client.entries = async () => {
      authed = false;
      throw new Error('Telescope API /entries failed: 401');
    };
    renderGate(client);
    await waitFor(() => expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy());
  });
});
