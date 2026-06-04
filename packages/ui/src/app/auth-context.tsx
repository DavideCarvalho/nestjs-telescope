import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthMode } from '../client/index.js';
import { useTelescopeClient } from '../react/index.js';

/**
 * The boot gate's view of dashboard auth:
 * - `loading`: the initial `auth.me()` call is in flight (blank/neutral splash).
 * - `disabled`: `dashboardAuth` is not configured (404) — render the app exactly
 *   as today; no logout button, no AuthScreen, no 401 flipping.
 * - `app`: authenticated — render the app plus a logout button in the header.
 * - `screen`: unauthenticated — render the AuthScreen for the offered `modes`.
 */
export type AuthPhase = 'loading' | 'disabled' | 'app' | 'screen';

interface AuthValue {
  phase: AuthPhase;
  /** Which AuthScreen to render; only meaningful in the `screen` phase. */
  modes: AuthMode[];
  /** Re-run `auth.me()` (after a login submit or a session-only Retry). */
  refresh: () => Promise<void>;
  /** Clear the session, then fall back to the AuthScreen. */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** True when a thrown Telescope API error carries a 401 (session expired). */
function isUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && / 401$/.test(error.message);
}

/**
 * Boots the dashboard behind `auth.me()` and keeps the gate in sync:
 * - runs `me()` once on mount to pick the initial phase;
 * - subscribes to the query cache so a 401 from ANY API call mid-session flips
 *   the app back to the AuthScreen (we re-run `me()` to learn the modes rather
 *   than hand-rolling a separate event bus);
 * - exposes `refresh`/`logout` for the AuthScreen + header logout button.
 *
 * When auth is `disabled`, this is a transparent pass-through: the app renders
 * exactly as it does without `dashboardAuth`.
 */
export function AuthProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const client = useTelescopeClient();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<AuthPhase>('loading');
  const [modes, setModes] = useState<AuthMode[]>([]);
  // Latched once a phase resolves: the 401 subscriber only flips back to the
  // AuthScreen when auth is actually in play (not in disabled mode).
  const authActiveRef = useRef(false);

  const value = useMemo<AuthValue>(() => {
    async function refresh(): Promise<void> {
      const result = await client.auth.me();
      if (result.status === 'authenticated') {
        authActiveRef.current = true;
        setPhase('app');
        return;
      }
      if (result.status === 'unauthenticated') {
        authActiveRef.current = true;
        setModes(result.modes);
        setPhase('screen');
        return;
      }
      authActiveRef.current = false;
      setPhase('disabled');
    }

    async function logout(): Promise<void> {
      await client.auth.logout();
      await refresh();
    }

    return { phase, modes, refresh, logout };
  }, [client, phase, modes]);

  // Initial boot: pick the phase from `auth.me()`.
  useEffect(() => {
    let cancelled = false;
    void client.auth.me().then((result) => {
      if (cancelled) return;
      if (result.status === 'authenticated') {
        authActiveRef.current = true;
        setPhase('app');
      } else if (result.status === 'unauthenticated') {
        authActiveRef.current = true;
        setModes(result.modes);
        setPhase('screen');
      } else {
        authActiveRef.current = false;
        setPhase('disabled');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Session-expiry: a 401 from any query while authenticated flips to the
  // AuthScreen. We piggyback on the existing query cache rather than adding a
  // new global event channel.
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      if (event.query.state.status !== 'error') return;
      if (!authActiveRef.current) return;
      if (!isUnauthorizedError(event.query.state.error)) return;
      void value.refresh();
    });
    return unsubscribe;
  }, [queryClient, value]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within an AuthProvider');
  return value;
}

/**
 * Non-throwing read for the header logout button: the DashboardLayout renders
 * in contexts WITHOUT an AuthProvider (e.g. standalone layout tests), so the
 * button degrades to absent rather than crashing when no gate is mounted.
 */
export function useAuthOptional(): AuthValue | null {
  return useContext(AuthContext);
}
