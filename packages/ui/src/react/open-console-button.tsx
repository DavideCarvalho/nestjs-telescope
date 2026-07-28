import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { OpenConsoleOptions } from '../client/console-session.js';
import { useOpenTelescopeConsole } from './use-open-console.js';

export interface OpenTelescopeConsoleButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'>,
    OpenConsoleOptions {
  /** Button label. Defaults to "Open Telescope". */
  children?: ReactNode;
  /** Shown while the session is being minted. Defaults to "Opening…". */
  pendingLabel?: ReactNode;
  /**
   * Render the refusal yourself. Omit and the button renders a plain `<p role="alert">` under
   * itself; pass `null` to render nothing and read the error from {@link useOpenTelescopeConsole}.
   */
  renderError?: ((error: Error) => ReactNode) | null;
}

/**
 * Drop-in launcher: the top tier, for a host that just wants a working button.
 *
 * Deliberately unstyled — it emits a bare `<button>` and forwards `className`/`style`/every other
 * button prop, so it inherits whatever design system the host already has instead of importing CSS
 * that would fight it. That matters more here than for the dashboard's own components: this one
 * renders inside the HOST's app, not inside Telescope's Tailwind bundle. When it doesn't fit, drop
 * to {@link useOpenTelescopeConsole} (same behaviour, your markup) or to `openTelescopeConsole` (no
 * React at all).
 *
 * The error is rendered by default rather than swallowed: a refused mint is the case a launcher most
 * needs to surface, and a button that silently does nothing reads as broken rather than forbidden.
 */
export function OpenTelescopeConsoleButton({
  children,
  pendingLabel,
  renderError,
  basePath,
  headers,
  fetch: fetchImpl,
  signal,
  navigate,
  disabled,
  ...buttonProps
}: OpenTelescopeConsoleButtonProps): JSX.Element {
  const { open, isPending, error } = useOpenTelescopeConsole({
    ...(basePath !== undefined ? { basePath } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(navigate !== undefined ? { navigate } : {}),
  });

  return (
    <>
      <button
        type="button"
        {...buttonProps}
        onClick={open}
        disabled={disabled || isPending}
        aria-busy={isPending || undefined}
      >
        {isPending ? (pendingLabel ?? 'Opening…') : (children ?? 'Open Telescope')}
      </button>
      {error &&
        renderError !== null &&
        (renderError?.(error) ?? <p role="alert">{error.message}</p>)}
    </>
  );
}
