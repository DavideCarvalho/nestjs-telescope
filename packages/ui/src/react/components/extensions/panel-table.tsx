import { type JSX, useMemo, useState } from 'react';
import { Table, TableBody, TableCell, TableRow } from '../../ui/table.js';
import { PanelColumnMenu } from './panel-column-menu.js';
import { PanelTableHeader } from './panel-table-header.js';
import { type TableColumnSpec, buildPanelColumns } from './table-columns.js';
import {
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type PanelRow,
  type SortingState,
  flexRender,
  panelTableFeatures,
  useTable,
} from './table-features.js';
import type { TableFilterState, TableSortState } from './table-query.js';

/**
 * How tall a scrolling (paged) table is allowed to get before its rows scroll
 * under a pinned header. A page of 50 rows is otherwise a ~1,500px card that
 * pushes every panel below it off the screen, and by the time you have scrolled
 * to row 40 the column labels are long gone. A short page never reaches the cap,
 * so it looks exactly as it did.
 */
const SCROLL_BODY_CLASS = 'max-h-[28rem]';

function keyForRow(row: PanelRow, columns: TableColumnSpec[], index: number): string {
  // The row's own values, as before, with the index appended: two identical rows
  // in one page are perfectly legal in provider output and used to collide into
  // a duplicate React key.
  return `${columns.map((column) => String(row[column.key] ?? '')).join('|')}#${index}`;
}

/**
 * A `table` panel, rendered through a TanStack Table v9 instance.
 *
 * The instance is what earns its place: sorting cycles, filter values, and
 * column visibility are all state machines this file would otherwise hand-roll.
 * What it deliberately does NOT do is transform rows — `manualSorting` and
 * `manualFiltering` are on and no row model is registered, so the rows render in
 * exactly the order the provider returned them, and the sort/filter state is
 * handed straight back up to the dashboard page to re-resolve that provider.
 * See `table-features.ts` for why.
 */
export function PanelTable({
  columns,
  rows,
  sort,
  onSortChange,
  filters,
  onFiltersChange,
  scrolls,
}: {
  columns: TableColumnSpec[];
  rows: PanelRow[];
  sort?: TableSortState | undefined;
  onSortChange?: ((sort: TableSortState | undefined) => void) | undefined;
  filters?: TableFilterState | undefined;
  onFiltersChange?: ((filters: TableFilterState) => void) | undefined;
  /** Cap the body height and pin the header — used for paged tables, which are
   *  the ones whose row count is unbounded from the panel's point of view. */
  scrolls?: boolean;
}): JSX.Element {
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({});
  const columnDefs = useMemo(() => buildPanelColumns(columns), [columns]);

  // The dashboard's own state shapes, projected into TanStack's. Both directions
  // are narrow on purpose: this table sorts by one column and filters with text,
  // which is all the SPI puts on the wire, so a multi-column sort arriving from
  // the library would have nowhere to go.
  const sorting: SortingState = sort ? [{ id: sort.key, desc: sort.dir === 'desc' }] : [];
  const columnFilters: ColumnFiltersState = Object.entries(filters ?? {}).map(([id, value]) => ({
    id,
    value,
  }));

  const table = useTable({
    features: panelTableFeatures,
    columns: columnDefs,
    data: rows,
    state: { sorting, columnFilters, columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      const first = next[0];
      // `enableSortingRemoval` is on by default, so the third click empties the
      // array — that is "unsorted", not "sorted by nothing", and it has to reach
      // the provider as an absent `sort` param or the table would be stuck.
      onSortChange?.(first ? { key: first.id, dir: first.desc ? 'desc' : 'asc' } : undefined);
    },
    onColumnFiltersChange: (updater) => {
      const next = typeof updater === 'function' ? updater(columnFilters) : updater;
      const applied: TableFilterState = {};
      for (const filter of next) {
        if (typeof filter.value === 'string' && filter.value !== '')
          applied[filter.id] = filter.value;
      }
      onFiltersChange?.(applied);
    },
    // Rows arrive already sorted, filtered and paginated by the provider.
    manualSorting: true,
    manualFiltering: true,
    getRowId: (row, index) => keyForRow(row, columns, index),
  });

  const leafColumns = table.getAllLeafColumns();
  // Asked of the columns, not of the rendered element: `<PanelColumnMenu/>` is an
  // element whether or not it will return null, so testing the element for null
  // would silently add a trailing column to every table.
  const hasMenu = leafColumns.some((column) => column.getCanHide());
  // The menu occupies its own trailing header cell when present, so the
  // empty-state row has to span it too or the "No data" text sits short.
  const bodyColumnCount = table.getVisibleLeafColumns().length + (hasMenu ? 1 : 0);

  return (
    <Table containerClassName={scrolls ? SCROLL_BODY_CLASS : ''}>
      <PanelTableHeader
        table={table}
        sticky={scrolls === true}
        {...(hasMenu ? { menu: <PanelColumnMenu columns={leafColumns} /> } : {})}
      />
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={bodyColumnCount} className="py-6 text-center text-muted-foreground">
              No data in this window.
            </TableCell>
          </TableRow>
        ) : null}
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>
            {row.getVisibleCells().map((cell) => (
              // Cells stay on one line: wrapping is what turned durable's "Workers"
              // panel into three-line rows. Anything wider than the card is reachable
              // by scrolling the table now, which is the cheaper trade of the two.
              <TableCell key={cell.id} className="whitespace-nowrap text-foreground">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
            {hasMenu ? <TableCell /> : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
