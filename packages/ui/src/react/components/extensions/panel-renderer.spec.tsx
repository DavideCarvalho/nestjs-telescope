import { fireEvent, render, screen } from '@testing-library/react';
import { cloneElement, isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  function Mock({ children }: { children: React.ReactNode }): JSX.Element {
    return (
      <div>
        {isValidElement(children) ? cloneElement(children, { width: 600, height: 300 }) : children}
      </div>
    );
  }
  return { ...actual, ResponsiveContainer: Mock };
});

import { PanelView } from './panel-renderer.js';

describe('PanelView (pure render from resolved data)', () => {
  it('renders a stat panel with a percent format', () => {
    render(
      <PanelView
        panel={{ kind: 'stat', title: 'Success rate', data: { provider: 'p' }, format: 'percent' }}
        data={{ value: 0.97 }}
      />,
    );
    expect(screen.getByText('Success rate')).toBeTruthy();
    expect(screen.getByText('97%')).toBeTruthy();
  });

  it('renders a table panel with deep-linked rows', () => {
    render(
      <PanelView
        panel={{
          kind: 'table',
          title: 'Recent failures',
          data: { provider: 'p' },
          columns: [
            { key: 'workflow', label: 'Workflow' },
            { key: 'runId', label: 'Run', link: { href: '/durable/runs/{runId}' } },
          ],
        }}
        data={{ rows: [{ workflow: 'checkout', runId: 'r1' }] }}
      />,
    );
    expect(screen.getByText('checkout')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'r1' });
    expect(link.getAttribute('href')).toBe('/durable/runs/r1');
  });

  it('shows an explicit empty state for a table panel with no rows', () => {
    render(
      <PanelView
        panel={{
          kind: 'table',
          title: 'Recent events',
          data: { provider: 'p' },
          columns: [{ key: 'lib', label: 'Library' }],
        }}
        data={{ rows: [] }}
      />,
    );
    expect(screen.getByText('No data in this window.')).toBeTruthy();
  });

  it('shows an explicit empty state for a topN panel with no items', () => {
    render(
      <PanelView
        panel={{ kind: 'topN', title: 'Busiest events', data: { provider: 'p' }, limit: 10 }}
        data={{ items: [] }}
      />,
    );
    expect(screen.getByText('Busiest events')).toBeTruthy();
    expect(screen.getByText('No data in this window.')).toBeTruthy();
  });

  it('renders an in-app hash-route link (traces waterfall) unmangled and not forced into a new tab', () => {
    render(
      <PanelView
        panel={{
          kind: 'table',
          title: 'Recent traces',
          data: { provider: 'p' },
          columns: [{ key: 'traceId', label: 'Trace', link: { href: '#/traces/{traceId}' } }],
        }}
        data={{ rows: [{ traceId: 't1' }] }}
      />,
    );
    const link = screen.getByRole('link', { name: 't1' });
    // The confirmed trace-view URL shape: `#/traces/{traceId}`. A plain anchor with
    // this href is a same-document navigation under the app's HashRouter — no
    // `target`/`rel` should be added (that's reserved for `link.external: true`).
    expect(link.getAttribute('href')).toBe('#/traces/t1');
    expect(link.getAttribute('target')).toBeNull();
    expect(link.getAttribute('rel')).toBeNull();
  });

  it('opens an external host-console link in a new tab, unlike a hash route', () => {
    render(
      <PanelView
        panel={{
          kind: 'table',
          title: 'Runs',
          data: { provider: 'p' },
          columns: [
            { key: 'runId', label: 'Run', link: { href: '/durable/runs/{runId}', external: true } },
          ],
        }}
        data={{ rows: [{ runId: 'r1' }] }}
      />,
    );
    const link = screen.getByRole('link', { name: 'r1' });
    expect(link.getAttribute('href')).toBe('/durable/runs/r1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  describe('paged table convention', () => {
    const columns = [{ key: 'runId', label: 'Run' }];

    it('renders bare-rows tables unchanged when `paged` is absent (no pager controls)', () => {
      render(
        <PanelView
          panel={{ kind: 'table', title: 'Runs', data: { provider: 'p' }, columns }}
          data={{ rows: [{ runId: 'r1' }] }}
        />,
      );
      expect(screen.getByText('r1')).toBeTruthy();
      expect(screen.queryByText(/Page \d+ of \d+/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Prev' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    });

    it('renders prev/next + "page X of Y" for a paged table and reports intent via onPageChange', () => {
      const onPageChange = vi.fn();
      render(
        <PanelView
          panel={{ kind: 'table', title: 'Runs', data: { provider: 'p' }, columns, paged: true }}
          data={{ rows: [{ runId: 'r2' }], total: 30, page: 2, limit: 10 }}
          onPageChange={onPageChange}
        />,
      );
      expect(screen.getByText('Page 2 of 3')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(onPageChange).toHaveBeenCalledWith(3);
      fireEvent.click(screen.getByRole('button', { name: 'Prev' }));
      expect(onPageChange).toHaveBeenCalledWith(1);
    });

    it('disables Prev on the first page and Next on the last page', () => {
      const { rerender } = render(
        <PanelView
          panel={{ kind: 'table', title: 'Runs', data: { provider: 'p' }, columns, paged: true }}
          data={{ rows: [], total: 30, page: 1, limit: 10 }}
        />,
      );
      expect(screen.getByRole('button', { name: 'Prev' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false);

      rerender(
        <PanelView
          panel={{ kind: 'table', title: 'Runs', data: { provider: 'p' }, columns, paged: true }}
          data={{ rows: [], total: 30, page: 3, limit: 10 }}
        />,
      );
      expect(screen.getByRole('button', { name: 'Prev' }).hasAttribute('disabled')).toBe(false);
      expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);
    });
  });

  describe('a table stays inside its card', () => {
    // A dashboard section is a `grid-cols-N` of fixed-width cells, so a card is
    // routinely narrower than the natural width of the table inside it (a 7-column
    // table in a `cols: 3` section). `w-full` is only a *preferred* width: with
    // `table-layout: auto` the browser still lays the table out at its min-content
    // width, and with nothing clipping it the extra columns paint OUTSIDE the card,
    // on top of the neighbouring panel. Every table therefore scrolls inside its own
    // container instead of overflowing the card.
    const columns = [
      { key: 'group', label: 'Group' },
      { key: 'worker', label: 'Worker' },
      { key: 'status', label: 'Status' },
    ];
    const rows = [
      { group: 'handle_stats_by_plan_name', worker: 'py-flip-flask-58974', status: 'ok' },
    ];

    it('scrolls a plain table horizontally rather than letting it overflow', () => {
      const { container } = render(
        <PanelView
          panel={{ kind: 'table', title: 'Workers', data: { provider: 'p' }, columns }}
          data={{ rows }}
        />,
      );
      const table = container.querySelector('table');
      expect(table?.parentElement?.className).toContain('overflow-x-auto');
    });

    it('scrolls a paged table too, leaving the pager header fixed above it', () => {
      const { container } = render(
        <PanelView
          panel={{ kind: 'table', title: 'Workers', data: { provider: 'p' }, columns, paged: true }}
          data={{ rows, total: 30, page: 1, limit: 10 }}
        />,
      );
      const table = container.querySelector('table');
      const scroller = table?.parentElement;
      expect(scroller?.className).toContain('overflow-x-auto');
      // The pager is a sibling of the scroller, not inside it — it must not scroll away.
      expect(scroller?.contains(screen.getByRole('button', { name: 'Next' }))).toBe(false);
    });

    it('keeps a cell on one line so a long value widens the scroll area, not the row', () => {
      // Wrapping is what turned the durable "Workers" table into three-line rows: with a
      // scroller in place, a long worker id belongs on one line behind a scrollbar.
      render(
        <PanelView
          panel={{ kind: 'table', title: 'Workers', data: { provider: 'p' }, columns }}
          data={{ rows }}
        />,
      );
      expect(screen.getByText('py-flip-flask-58974').className).toContain('whitespace-nowrap');
      expect(screen.getByText('Worker').className).toContain('whitespace-nowrap');
    });
  });
});
