import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OpenTelescopeConsoleButton } from './open-console-button.js';
import { openTelescopeConsoleMutationOptions } from './use-open-console.js';

function response(init: { status?: number; type?: string } = {}): Response {
  const status = init.status ?? 204;
  return { ok: status >= 200 && status < 300, status, type: init.type ?? 'basic' } as Response;
}

describe('openTelescopeConsoleMutationOptions', () => {
  it('returns a useMutation-shaped object without depending on TanStack', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const navigate = vi.fn();
    const options = openTelescopeConsoleMutationOptions({ fetch: fetchMock, navigate });

    // The point of the shape: a host passes this straight into `useMutation`, and this package
    // never imports @tanstack/react-query — so a host that doesn't use Query pays nothing.
    expect(options.mutationKey).toEqual(['telescope', 'console', 'open', null]);
    await options.mutationFn();
    expect(navigate).toHaveBeenCalledWith('/telescope');
  });

  it('keys by basePath so two mounts do not share cache state', () => {
    expect(openTelescopeConsoleMutationOptions({ basePath: '/ops' }).mutationKey).toEqual([
      'telescope',
      'console',
      'open',
      '/ops',
    ]);
  });
});

describe('<OpenTelescopeConsoleButton>', () => {
  it('mints and navigates on click', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const navigate = vi.fn();
    render(<OpenTelescopeConsoleButton fetch={fetchMock} navigate={navigate} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/telescope'));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/telescope/api/auth/session');
  });

  it('surfaces a refusal instead of failing silently', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 403 }));
    render(<OpenTelescopeConsoleButton fetch={fetchMock} navigate={vi.fn()} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    // A button that silently does nothing reads as broken rather than forbidden — the single most
    // important behaviour for a launcher, and the reason the error renders by default.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/HTTP 403/));
  });

  it('does not navigate when the mint is refused', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 401 }));
    const navigate = vi.fn();
    render(<OpenTelescopeConsoleButton fetch={fetchMock} navigate={navigate} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(navigate).not.toHaveBeenCalled();
  });

  it('surfaces the sign-in redirect as a refusal rather than a false success', async () => {
    // The trap `../client/console-session.ts` exists to close: an auth layer that rewrites 401 into
    // a redirect would otherwise resolve 200 against sign-in HTML and navigate to a session-less
    // console. The button must show it, not follow it.
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 0, type: 'opaqueredirect' }));
    const navigate = vi.fn();
    render(<OpenTelescopeConsoleButton fetch={fetchMock} navigate={navigate} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/redirect/));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('renders a custom error node when asked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 403 }));
    render(
      <OpenTelescopeConsoleButton
        fetch={fetchMock}
        navigate={vi.fn()}
        renderError={(error) => <span data-testid="mine">{error.message}</span>}
      />,
    );

    await act(async () => {
      screen.getByRole('button').click();
    });

    await waitFor(() => expect(screen.getByTestId('mine')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders nothing for the error when renderError is null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 403 }));
    render(<OpenTelescopeConsoleButton fetch={fetchMock} navigate={vi.fn()} renderError={null} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    // Opting out entirely must be possible for a host that surfaces errors its own way (a toast).
    await waitFor(() =>
      expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('forwards button props so it inherits the host design system', () => {
    render(
      <OpenTelescopeConsoleButton
        className="btn btn-primary"
        data-testid="launcher"
        title="Open it"
      />,
    );

    // Unstyled-and-forwarding is the whole reason this ships no CSS.
    const button = screen.getByTestId('launcher');
    expect(button.className).toBe('btn btn-primary');
    expect(button.getAttribute('title')).toBe('Open it');
    expect(button.textContent).toBe('Open Telescope');
  });

  it('disables itself while in flight', async () => {
    let release: (value: Response) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    render(<OpenTelescopeConsoleButton fetch={fetchMock} navigate={vi.fn()} />);
    const button = screen.getByRole('button');

    await act(async () => {
      button.click();
    });

    // Without this a double-click fires two mints, and the second can land after the navigation.
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toBe('Opening…');
    await act(async () => {
      release(response());
    });
  });

  it('stays pending after a successful mint so the leaving page does not flicker', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const navigate = vi.fn();
    render(<OpenTelescopeConsoleButton fetch={fetchMock} navigate={navigate} />);
    const button = screen.getByRole('button');

    await act(async () => {
      button.click();
    });

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    // The navigation is already underway; going back to idle would read as "ready to click again"
    // on a page that is leaving.
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
