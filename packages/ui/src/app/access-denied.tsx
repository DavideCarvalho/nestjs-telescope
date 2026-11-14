import { useEffect, useState } from 'react';
import { TELESCOPE_ACCESS_DENIED_EVENT, type TelescopeAccessDenial } from '../client/index.js';

/**
 * The latest refusal from the console's `authorize` (dispatched by the
 * client's default `onAccessDenied`), or `null` while access is fine.
 */
export function useAccessDenied(): TelescopeAccessDenial | null {
  const [denial, setDenial] = useState<TelescopeAccessDenial | null>(null);
  useEffect(() => {
    const listener = (event: Event) => {
      setDenial((event as CustomEvent<TelescopeAccessDenial>).detail);
    };
    window.addEventListener(TELESCOPE_ACCESS_DENIED_EVENT, listener);
    return () => window.removeEventListener(TELESCOPE_ACCESS_DENIED_EVENT, listener);
  }, []);
  return denial;
}

/** Shown in place of the dashboard when the console refuses the viewer. */
export function AccessDenied({ denial }: { denial: TelescopeAccessDenial }): React.JSX.Element {
  const signIn = denial.reason === 'unauthenticated';
  return (
    <main
      role="alert"
      className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground"
    >
      <div className="max-w-md aviary-surface rounded-lg border border-border p-6 text-center">
        <h1 className="text-lg font-semibold">{signIn ? 'Sign in required' : 'Access denied'}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {signIn
            ? 'Sign in to the app to open Telescope, then reload this page.'
            : 'Your account is not allowed to open Telescope.'}
        </p>
      </div>
    </main>
  );
}

/** Renders the dashboard, or {@link AccessDenied} once the console refuses the viewer. */
export function AccessGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const denial = useAccessDenied();
  if (denial) return <AccessDenied denial={denial} />;
  return <>{children}</>;
}
