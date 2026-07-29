import { type FormEvent, useId, useState } from 'react';
import type { AuthMode } from '../client/index.js';
import { useTelescopeClient } from '../react/index.js';
import { Button, Input } from '../react/ui/index.js';
import { useAuth } from './auth-context.js';

/** Telescope-branded shell shared by both AuthScreen variants. */
function AuthCard({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 font-mono text-sm text-foreground">
      <div className="w-full max-w-sm rounded-lg border border-line bg-panel p-8 shadow-2xl">
        <div className="mb-6 text-center text-lg font-semibold text-brand">Telescope</div>
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
  const usernameId = useId();
  const passwordId = useId();
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
      {/* `htmlFor` rather than wrapping: <Input> is a component, so the linter (and any
          static a11y checker) cannot see the <input> it renders. */}
      <label className="flex flex-col gap-1.5" htmlFor={usernameId}>
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Username</span>
        <Input
          id={usernameId}
          type="text"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className="px-3 py-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1.5" htmlFor={passwordId}>
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Password</span>
        <Input
          id={passwordId}
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="px-3 py-2 text-sm"
        />
      </label>
      {error !== null ? (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        variant="brand"
        size="md"
        disabled={submitting}
        className="mt-2 uppercase tracking-wide"
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>
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
      <p className="text-sm font-medium text-foreground">Open Telescope from your application</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Your session is minted by the host app. Use its &ldquo;Open Telescope&rdquo; action to sign
        in, then come back here.
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="mt-2 rounded border border-line px-3 py-2 text-xs font-medium uppercase tracking-wide text-foreground transition-colors hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50"
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
