import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConsoleSessionError,
  type OpenConsoleOptions,
  openTelescopeConsole,
  telescopeConsoleSessionUrl,
} from '../client/console-session.js';

/**
 * React layer over `openTelescopeConsole` — the middle tier between the bare function
 * (`../client/console-session.ts`) and the drop-in `<OpenTelescopeConsoleButton>`.
 *
 * You get the state a launcher UI actually needs (in-flight, error) and keep full control of the
 * markup. Nothing here is Telescope-specific beyond the endpoint: it is a mint-then-navigate call
 * with the two states that call can be in.
 */
export interface UseOpenConsoleResult {
  /** Start the mint-then-navigate. Never rejects — read `error` instead. */
  open: () => void;
  /** True from the click until the navigation starts, or until it fails. */
  isPending: boolean;
  /** The last refusal, or `null`. Cleared when `open()` is called again. */
  error: ConsoleSessionError | null;
  /** Drop a stale error without retrying — e.g. when a dialog closes. */
  reset: () => void;
}

export function useOpenTelescopeConsole(options: OpenConsoleOptions = {}): UseOpenConsoleResult {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ConsoleSessionError | null>(null);

  // Kept in a ref so a caller passing an inline object literal (the common case) doesn't change the
  // identity of `open` on every render, which would defeat memoizing anything downstream.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const open = useCallback(() => {
    setIsPending(true);
    setError(null);
    void openTelescopeConsole(optionsRef.current)
      .then(() => {
        // Deliberately NOT clearing `isPending` on success: the navigation is already underway and
        // this component is about to be torn down. Flipping the button back to idle first produces
        // a visible flicker of "ready to click again" on a page that is leaving.
        //
        // "About to be torn down" is not guaranteed, though — see the `pageshow` effect below for
        // the case where the page comes back instead of dying.
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof ConsoleSessionError
            ? cause
            : // A non-`ConsoleSessionError` can only come from the caller's own `navigate`, so name
              // the endpoint this hook was pointed at rather than leaving `url` empty.
              new ConsoleSessionError(
                String(cause),
                telescopeConsoleSessionUrl(optionsRef.current.basePath),
              ),
        );
        setIsPending(false);
      });
  }, []);

  // The success path above leaves `isPending` true on the assumption that the page is leaving for
  // good. The back/forward cache breaks that assumption: instead of destroying the document, the
  // browser freezes it and restores it — React state and all — when the user presses Back. Without
  // this the user returns from the console to a spinner that never stops, on a button that is
  // permanently disabled because nothing else ever clears the flag.
  //
  // `persisted === true` is the ONLY signal that distinguishes a restore from a fresh load, and the
  // condition is load-bearing in both directions: a normal `pageshow` (`persisted: false`) fires on
  // every page load and must not touch anything, and a mint that is genuinely still in flight must
  // keep its spinner. Dropping the check to "simplify" reintroduces the flicker this hook avoids.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) setIsPending(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { open, isPending, error, reset };
}

/**
 * TanStack Query integration WITHOUT a TanStack dependency: the returned object is the shape
 * `useMutation` takes, so a host that already uses Query wires the launcher into its own cache,
 * devtools and error handling with no extra adapter — and a host that doesn't never pays for it.
 *
 * ```ts
 * const { mutate, isPending } = useMutation(openTelescopeConsoleMutationOptions({ headers }));
 * ```
 */
export function openTelescopeConsoleMutationOptions(options: OpenConsoleOptions = {}): {
  mutationKey: readonly unknown[];
  mutationFn: () => Promise<void>;
} {
  return {
    mutationKey: ['telescope', 'console', 'open', options.basePath ?? null] as const,
    mutationFn: () => openTelescopeConsole(options),
  };
}
