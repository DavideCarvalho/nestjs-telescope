import { type FormEvent, useState } from 'react';
import type { AuthMode } from '../client/index.js';
import { useTelescopeClient } from '../react/index.js';
import { useAuth } from './auth-context.js';

/** Telescope-branded shell shared by both AuthScreen variants. */
function AuthCard({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 font-mono text-sm text-zinc-200">
      <div className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-8 shadow-2xl">
        <div className="mb-6 text-center text-lg font-semibold text-emerald-400">Telescope</div>
        {children}
      </div>
    </div>
  );
}

/** Mode B: built-in username/password login posting to `/auth/login`. */
function LoginForm(): JSX.Element {
  const client = useTelescopeClient();
  const { refresh } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await client.auth.login(username, password);
      if (result.ok) {
        await refresh();
        return;
      }
      setError(result.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wide text-zinc-500">Username</span>
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/60"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs uppercase tracking-wide text-zinc-500">Password</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/60"
        />
      </label>
      {error !== null ? (
        <p role="alert" className="text-xs text-rose-400">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={submitting}
        className="mt-2 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-medium uppercase tracking-wide text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

/** Mode A only: the host app mints the session; nothing to do here but retry. */
function SessionInstructions(): JSX.Element {
  const { refresh } = useAuth();
  const [retrying, setRetrying] = useState(false);

  async function onRetry(): Promise<void> {
    setRetrying(true);
    try {
      await refresh();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 text-center">
      <p className="text-sm font-medium text-zinc-200">Open Telescope from your application</p>
      <p className="text-xs leading-relaxed text-zinc-500">
        Your session is minted by the host app. Use its &ldquo;Open Telescope&rdquo; action to sign
        in, then come back here.
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="mt-2 rounded border border-zinc-700 px-3 py-2 text-xs font-medium uppercase tracking-wide text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {retrying ? 'Checking…' : 'Retry'}
      </button>
    </div>
  );
}

/**
 * Rendered in place of the app when `auth.me()` is unauthenticated. Picks the
 * variant from the offered modes: a login form when `login` is available,
 * otherwise the session-only instruction card.
 */
export function AuthScreen({ modes }: { modes: AuthMode[] }): JSX.Element {
  const hasLogin = modes.includes('login');
  return <AuthCard>{hasLogin ? <LoginForm /> : <SessionInstructions />}</AuthCard>;
}
