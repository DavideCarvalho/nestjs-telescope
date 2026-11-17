import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NuqsHashAdapter } from '../../aviary-kit/url-state/nuqs-hash-adapter';
import type { FleetApp, FleetInstance, FleetView } from '../../client/index.js';
import { visibleTopNav } from '../dashboard-layout.js';
import { settleUrlWrites } from '../settle-url.js';
import {
  FleetSection,
  formatDuration,
  incidentLabel,
  narrowToRole,
  rolloutLabel,
} from './fleet-page.js';

afterEach(settleUrlWrites);

/** The role filter lives in the URL, so the page needs the console's nuqs adapter. */
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: NuqsHashAdapter });

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const MIN = 60_000;

function instance(overrides: Partial<FleetInstance> = {}): FleetInstance {
  return {
    app: 'shop',
    instanceId: 'shop-1',
    host: 'shop-web-0',
    pid: 1,
    version: 'v2',
    bootedAt: NOW - 30 * MIN,
    firstSeenAt: NOW - 30 * MIN,
    lastSeenAt: NOW - 5_000,
    state: 'ready',
    intervalMs: 15_000,
    checks: [],
    shipping: null,
    status: 'up',
    uptimeMs: 30 * MIN,
    health: 'ok',
    ...overrides,
  };
}

function app(overrides: Partial<FleetApp> = {}): FleetApp {
  return {
    app: 'shop',
    counts: { up: 2, starting: 0, draining: 1, gone: 0 },
    versions: [{ version: 'v2', instances: 2 }],
    instances: [instance(), instance({ instanceId: 'shop-2', host: 'shop-web-1' })],
    deploys: [
      {
        version: 'v2',
        previous: 'v1',
        startedAt: NOW - 10 * MIN,
        live: 2,
        total: 3,
        progress: 2 / 3,
        complete: false,
      },
    ],
    restartLoops: [
      { host: 'shop-worker-0', restarts: 3, since: NOW - 7 * MIN, lastBootAt: NOW - MIN },
    ],
    checks: [
      {
        name: 'Redis',
        status: 'down',
        since: NOW - 12 * MIN,
        message: 'OOM command not allowed',
        affected: 4,
        of: 4,
        critical: true,
        exceptions: [
          { familyHash: 'f', class: 'ReplyError', message: 'OOM', count: 31, entryId: 'e-1' },
        ],
      },
    ],
    shipping: { buffered: 12, dropped: 0, maxLagMs: 2_000 },
    ...overrides,
  };
}

const view = (overrides: Partial<FleetView> = {}): FleetView => ({
  enabled: true,
  notice: null,
  now: NOW,
  apps: [app()],
  self: null,
  ...overrides,
});

describe('Fleet page', () => {
  it('shows counts, instances, the rollout, the restart loop and the failing check', () => {
    render(<FleetSection view={view()} onOpenEntry={() => {}} />);
    expect(screen.getByRole('heading', { name: 'shop' })).toBeTruthy();
    expect(screen.getByText('shop-web-0')).toBeTruthy();
    expect(screen.getByText('2/3 live')).toBeTruthy();
    expect(screen.getByText(/restarted 3 times in 7 min/)).toBeTruthy();
    expect(screen.getByText('Redis: down for 12 min on 4 of 4 instances')).toBeTruthy();
    expect(screen.getByText('0 dropped · lag 2 s')).toBeTruthy();
  });

  it('opens a related exception entry', () => {
    const open = vi.fn();
    render(<FleetSection view={view()} onOpenEntry={open} />);
    fireEvent.click(screen.getByTitle('ReplyError: OOM'));
    expect(open).toHaveBeenCalledWith('e-1');
  });

  it('shows the notice when the fleet is not kept or hidden, and an empty state', () => {
    const { rerender } = render(
      <FleetSection
        view={view({ enabled: false, notice: 'This telescope keeps no fleet.', apps: [] })}
        onOpenEntry={() => {}}
      />,
    );
    expect(screen.getByText('No fleet here')).toBeTruthy();
    rerender(
      <FleetSection
        view={view({ notice: 'Instances are shared by every organization.', apps: [] })}
        onOpenEntry={() => {}}
      />,
    );
    expect(screen.getByText('The fleet is hidden')).toBeTruthy();
    rerender(<FleetSection view={view({ apps: [] })} onOpenEntry={() => {}} />);
    expect(screen.getByText('No instance has reported yet')).toBeTruthy();
  });

  it('labels edge cases: no live instances, unknown checks stay neutral', () => {
    expect(
      rolloutLabel({
        version: 'v2',
        previous: 'v1',
        startedAt: 0,
        live: 0,
        total: 0,
        progress: 1,
        complete: true,
      }),
    ).toBe('no live instances');
    render(
      <FleetSection
        view={view({
          apps: [
            app({
              checks: [
                {
                  name: 'stripe',
                  status: 'unknown',
                  since: NOW - MIN,
                  message: null,
                  affected: 1,
                  of: 2,
                  critical: false,
                  exceptions: [],
                },
              ],
            }),
          ],
        })}
        onOpenEntry={() => {}}
      />,
    );
    const card = screen.getByText('stripe: unknown for 1 min on 1 of 2 instances').closest('div')
      ?.parentElement as HTMLElement;
    expect(card.className).toContain('border-line');
    expect(card.className).not.toContain('warn');
  });

  it('formats durations and incidents', () => {
    expect(formatDuration(500)).toBe('1 s');
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(12 * MIN)).toBe('12 min');
    expect(formatDuration(90 * MIN)).toBe('1.5 h');
    expect(formatDuration(3 * 86_400_000)).toBe('3 d');
    expect(formatDuration(-5)).toBe('1 s');
    expect(incidentLabel(app().checks[0]!, NOW)).toBe('Redis: down for 12 min on 4 of 4 instances');
  });

  it('is in the nav only where the server keeps a fleet', () => {
    const nav = [{ to: '/fleet', label: 'Fleet', end: false }];
    expect(visibleTopNav(nav, true, false, undefined)).toEqual([]);
    expect(visibleTopNav(nav, true, false, false)).toEqual([]);
    expect(visibleTopNav(nav, true, false, true)).toEqual(nav);
  });

  it('shows each instance role; an older server without roles shows web and no filter', () => {
    render(<FleetSection view={view()} onOpenEntry={() => {}} />);
    expect(screen.getAllByText('web')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'All roles' })).toBeNull();
  });

  it('filters by role: recounts the cards and narrows instances and restart loops', () => {
    const mixed = app({
      instances: [
        instance(),
        instance({ instanceId: 'w-1', host: 'shop-worker-0', role: 'bullmq' }),
        instance({ instanceId: 'w-2', host: 'shop-worker-1', role: 'bullmq', status: 'gone' }),
      ],
      counts: { up: 2, starting: 0, draining: 0, gone: 1 },
      restartLoops: [
        {
          host: 'shop-worker-0',
          role: 'bullmq',
          restarts: 3,
          since: NOW - 7 * MIN,
          lastBootAt: NOW - MIN,
        },
      ],
    });
    render(
      <FleetSection
        view={view({ apps: [mixed, app({ app: 'billing', restartLoops: [] })] })}
        onOpenEntry={() => {}}
      />,
    );
    expect(screen.getByText(/\(bullmq\)/)).toBeTruthy();
    const all = screen.getByRole('button', { name: 'All roles' });
    expect(all.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'web' }));
    expect(screen.getByRole('button', { name: 'web' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('shop-worker-0')).toBeNull();
    expect(screen.queryByText(/restarted 3 times/)).toBeNull();
    // billing (web only) stays.
    expect(screen.getByRole('heading', { name: 'billing' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'bullmq' }));
    expect(screen.queryByText('shop-web-0')).toBeNull();
    expect(screen.getByText('shop-worker-1')).toBeTruthy();
    // billing runs no worker: hidden; shop's cards recount its 2 workers (1 up, 1 gone).
    expect(screen.queryByRole('heading', { name: 'billing' })).toBeNull();
    expect(narrowToRole(mixed, 'bullmq').counts).toEqual({
      up: 1,
      starting: 0,
      draining: 0,
      gone: 1,
    });
  });

  it('keeps the picked role in the URL and opens on it', async () => {
    const mixed = app({
      instances: [
        instance(),
        instance({ instanceId: 'w-1', host: 'shop-worker-0', role: 'bullmq' }),
      ],
    });
    window.history.replaceState(null, '', '/#/fleet');
    const first = render(<FleetSection view={view({ apps: [mixed] })} onOpenEntry={() => {}} />);
    const start = window.history.length;
    fireEvent.click(screen.getByRole('button', { name: 'bullmq' }));
    await waitFor(() => expect(window.location.hash).toBe('#/fleet?role=bullmq'));
    // picking a role is a history step
    expect(window.history.length).toBe(start + 1);
    first.unmount();

    render(<FleetSection view={view({ apps: [mixed] })} onOpenEntry={() => {}} />);
    expect(screen.getByRole('button', { name: 'bullmq' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.queryByText('shop-web-0')).toBeNull();
  });
});
