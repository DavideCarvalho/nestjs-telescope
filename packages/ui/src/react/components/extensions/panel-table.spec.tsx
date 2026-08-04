import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PanelTable } from './panel-table.js';
import type { TableColumnSpec } from './table-columns.js';

const plain: TableColumnSpec[] = [
  { key: 'runId', label: 'Run' },
  { key: 'status', label: 'Status' },
];

const rows = [
  { runId: 'r1', status: 'ok' },
  { runId: 'r2', status: 'failed' },
];

describe('PanelTable', () => {
  describe('a panel that opted into nothing renders as it always did', () => {
    // The backward-compatibility contract for the whole SPI change: every
    // dashboard shipped by a sibling library predates these flags.
    it('has no controls in the header at all', () => {
      render(<PanelTable columns={plain} rows={rows} />);
      expect(screen.getByText('Run')).toBeTruthy();
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('renders one header cell per declared column and nothing extra', () => {
      // A trailing column-menu cell would misalign the header against the body.
      const { container } = render(<PanelTable columns={plain} rows={rows} />);
      expect(container.querySelectorAll('thead tr').length).toBe(1);
      expect(container.querySelectorAll('thead th').length).toBe(2);
      expect(container.querySelectorAll('tbody tr:first-child td').length).toBe(2);
    });

    it('keeps the provider row order rather than sorting in the browser', () => {
      const { container } = render(
        <PanelTable columns={plain} rows={[{ runId: 'zeta' }, { runId: 'alpha' }]} />,
      );
      const cells = [...container.querySelectorAll('tbody td')].map((td) => td.textContent);
      expect(cells.slice(0, 1)).toEqual(['zeta']);
    });

    it('spans the empty state across every column', () => {
      const { container } = render(<PanelTable columns={plain} rows={[]} />);
      expect(screen.getByText('No data in this window.')).toBeTruthy();
      expect(container.querySelector('tbody td')?.getAttribute('colspan')).toBe('2');
    });

    it('renders two identical rows instead of collapsing them into one', () => {
      // Rows used to be keyed by their own values alone, so a provider returning
      // duplicates handed React a duplicate key.
      const { container } = render(
        <PanelTable columns={plain} rows={[{ runId: 'r1' }, { runId: 'r1' }]} />,
      );
      expect(container.querySelectorAll('tbody tr').length).toBe(2);
    });
  });

  describe('sorting', () => {
    const sortable: TableColumnSpec[] = [
      { key: 'runId', label: 'Run', sortable: true },
      { key: 'status', label: 'Status' },
    ];

    it('makes only the sortable column a control', () => {
      render(<PanelTable columns={sortable} rows={rows} />);
      expect(screen.getByRole('button', { name: /Run/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Status/ })).toBeNull();
    });

    it('cycles ascending → descending → unsorted and reports each step', () => {
      // The third state is the one worth pinning: TanStack empties the sorting
      // array, which has to reach the caller as `undefined` (drop the `sort`
      // param) rather than as an empty sort nobody can express on the wire.
      const onSortChange = vi.fn();
      const { rerender } = render(
        <PanelTable columns={sortable} rows={rows} onSortChange={onSortChange} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Run/ }));
      expect(onSortChange).toHaveBeenLastCalledWith({ key: 'runId', dir: 'asc' });

      rerender(
        <PanelTable
          columns={sortable}
          rows={rows}
          sort={{ key: 'runId', dir: 'asc' }}
          onSortChange={onSortChange}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Run/ }));
      expect(onSortChange).toHaveBeenLastCalledWith({ key: 'runId', dir: 'desc' });

      rerender(
        <PanelTable
          columns={sortable}
          rows={rows}
          sort={{ key: 'runId', dir: 'desc' }}
          onSortChange={onSortChange}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Run/ }));
      expect(onSortChange).toHaveBeenLastCalledWith(undefined);
    });

    it('announces the applied direction on the header cell, not just as a glyph', () => {
      const { container } = render(
        <PanelTable columns={sortable} rows={rows} sort={{ key: 'runId', dir: 'desc' }} />,
      );
      const heads = [...container.querySelectorAll('th')];
      expect(heads[0]?.getAttribute('aria-sort')).toBe('descending');
      expect(heads[1]?.getAttribute('aria-sort')).toBeNull();
    });

    it('does not reorder the rows it was handed — the provider already did', () => {
      const { container } = render(
        <PanelTable
          columns={sortable}
          rows={[{ runId: 'zeta' }, { runId: 'alpha' }]}
          sort={{ key: 'runId', dir: 'asc' }}
        />,
      );
      const first = container.querySelector('tbody td')?.textContent;
      expect(first).toBe('zeta');
    });
  });

  describe('filtering', () => {
    const filterable: TableColumnSpec[] = [
      { key: 'runId', label: 'Run', filterable: true },
      { key: 'status', label: 'Status' },
    ];

    it('adds a filter row with a box only under the filterable column', () => {
      const { container } = render(<PanelTable columns={filterable} rows={rows} />);
      expect(container.querySelectorAll('thead tr').length).toBe(2);
      expect(screen.getAllByRole('textbox').length).toBe(1);
      expect(screen.getByLabelText('Filter by runId')).toBeTruthy();
    });

    it('commits on Enter, not on every keystroke', () => {
      // Every commit is a provider resolve — i.e. a query against whatever store
      // the extension sits on. Typing "checkout" must not be eight of them.
      const onFiltersChange = vi.fn();
      render(<PanelTable columns={filterable} rows={rows} onFiltersChange={onFiltersChange} />);
      const box = screen.getByLabelText('Filter by runId');
      fireEvent.change(box, { target: { value: 'r1' } });
      expect(onFiltersChange).not.toHaveBeenCalled();
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(onFiltersChange).toHaveBeenCalledWith({ runId: 'r1' });
    });

    it('commits on blur too, so a click elsewhere does not silently drop the filter', () => {
      const onFiltersChange = vi.fn();
      render(<PanelTable columns={filterable} rows={rows} onFiltersChange={onFiltersChange} />);
      const box = screen.getByLabelText('Filter by runId');
      fireEvent.change(box, { target: { value: 'r1' } });
      fireEvent.blur(box);
      expect(onFiltersChange).toHaveBeenCalledWith({ runId: 'r1' });
    });

    it('drops the filter entirely when the box is cleared', () => {
      const onFiltersChange = vi.fn();
      render(
        <PanelTable
          columns={filterable}
          rows={rows}
          filters={{ runId: 'r1' }}
          onFiltersChange={onFiltersChange}
        />,
      );
      const box = screen.getByLabelText('Filter by runId');
      fireEvent.change(box, { target: { value: '' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(onFiltersChange).toHaveBeenCalledWith({});
    });

    it('shows the applied filter and re-seeds the box when it changes underneath', () => {
      const { rerender } = render(
        <PanelTable columns={filterable} rows={rows} filters={{ runId: 'r1' }} />,
      );
      expect(screen.getByLabelText('Filter by runId').getAttribute('value')).toBe('r1');
      rerender(<PanelTable columns={filterable} rows={rows} filters={{}} />);
      expect(screen.getByLabelText('Filter by runId').getAttribute('value')).toBe('');
    });

    it('does not reduce the rows it was handed — the provider already did', () => {
      const { container } = render(
        <PanelTable columns={filterable} rows={rows} filters={{ runId: 'nothing-matches' }} />,
      );
      expect(container.querySelectorAll('tbody tr').length).toBe(2);
    });
  });

  describe('column visibility', () => {
    const hideable: TableColumnSpec[] = [
      { key: 'runId', label: 'Run' },
      { key: 'status', label: 'Status', hideable: true },
    ];

    it('shows no menu when no column opted in', () => {
      render(<PanelTable columns={plain} rows={rows} />);
      expect(screen.queryByRole('button', { name: /Columns/ })).toBeNull();
    });

    it('hides a column from the header and every row when toggled off', () => {
      const { container } = render(<PanelTable columns={hideable} rows={rows} />);
      fireEvent.click(screen.getByRole('button', { name: /Columns/ }));
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Status/ }));
      expect(screen.queryByText('failed')).toBeNull();
      // The trailing menu cell keeps header and body aligned: one visible data
      // column plus the menu column, in both.
      expect(container.querySelectorAll('thead th').length).toBe(2);
      expect(container.querySelectorAll('tbody tr:first-child td').length).toBe(2);
    });

    it('only offers the columns that opted in', () => {
      render(<PanelTable columns={hideable} rows={rows} />);
      fireEvent.click(screen.getByRole('button', { name: /Columns/ }));
      expect(screen.getAllByRole('menuitemcheckbox').length).toBe(1);
    });

    it('closes on Escape rather than sitting over the panel below it', () => {
      render(<PanelTable columns={hideable} rows={rows} />);
      fireEvent.click(screen.getByRole('button', { name: /Columns/ }));
      expect(screen.getByRole('menu')).toBeTruthy();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  describe('a scrolling table pins its header', () => {
    it('caps the scroll container and sticks the header cells to it', () => {
      // Sticky has to position against the container the vendored `Table`
      // renders: that div is already a scroll container, so a max-height applied
      // anywhere further out gives a scrolling ancestor the cells cannot see.
      const { container } = render(<PanelTable columns={plain} rows={rows} scrolls />);
      const scroller = container.querySelector('table')?.parentElement;
      expect(scroller?.className).toContain('max-h-');
      expect(scroller?.className).toContain('overflow-x-auto');
      expect(container.querySelector('thead th')?.className).toContain('sticky');
    });

    it('leaves the header of a non-scrolling table unpinned', () => {
      const { container } = render(<PanelTable columns={plain} rows={rows} />);
      expect(container.querySelector('table')?.parentElement?.className).not.toContain('max-h-');
      expect(container.querySelector('thead th')?.className).not.toContain('sticky');
    });
  });
});
