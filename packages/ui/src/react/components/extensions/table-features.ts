import {
  type Cell,
  type Column,
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type Header,
  type Row,
  type SortingState,
  type Table,
  columnFilteringFeature,
  columnVisibilityFeature,
  flexRender,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';

/**
 * This package's entire binding to `@tanstack/react-table`.
 *
 * The rule the extension dashboard holds to: **no other module imports the
 * library**. Everything a panel table needs — the hook, `flexRender`, and the
 * pre-bound types — is re-exported from here, so the next major version is a
 * change in one file rather than a sweep over every header, body and menu
 * module. That matters more in v9 than it did in v8, because v9 makes almost
 * every public type generic in the registered feature set: a bare
 * `Column<TData>` no longer type-checks anywhere.
 *
 * v9 installs a feature's state slice and instance methods **only when that
 * feature is registered below**. An unregistered feature does not fail loudly —
 * the method is simply absent, which at the call site is indistinguishable from
 * "this API was removed in v9". `table-features.spec.ts` asserts every method
 * the dashboard actually calls, so deleting an entry here fails a test instead
 * of blanking a panel.
 */
export const panelTableFeatures = tableFeatures({
  // column.getCanSort / getIsSorted / getToggleSortingHandler, state.sorting.
  // Sorting itself is the provider's: `manualSorting` is on and the resolved
  // state is handed back up to the dashboard page, which re-resolves the
  // provider with it.
  rowSortingFeature,
  // column.getCanFilter / getFilterValue / setFilterValue, state.columnFilters.
  // Server-side for the same reason.
  columnFilteringFeature,
  // column.getCanHide / getIsVisible / toggleVisibility, row.getVisibleCells.
  // The one genuinely client-side feature here — hiding a column is a display
  // choice, so it never reaches the provider.
  columnVisibilityFeature,
  // Deliberately NO `rowPaginationFeature`. A paged panel's pager is driven
  // entirely by what the provider returned (`{ total, page, limit }`); nothing
  // calls a TanStack pagination API, so registering the feature would add a
  // `pagination` state slice that has to be kept in sync with the real one and
  // could disagree with it.
  //
  // Deliberately NO `columnSizingFeature` either: it contributes `size: 150`
  // through `getDefaultColumnDef()` to every column, which would pin every
  // dashboard table to fixed 150px columns and leave no way to express "size
  // this from the content" — the layout these tables actually want.
});

/**
 * No client row models are registered above, and that is the point:
 * `createSortedRowModel` / `createFilteredRowModel` / `createPaginatedRowModel`
 * would re-do server-side work over the single page already in hand — sorting
 * 50 rows out of 50,000 and presenting the result as "the top of the list".
 */
export type PanelTableFeatures = typeof panelTableFeatures;

/**
 * A dashboard table row. Provider rows are opaque JSON keyed by the panel's
 * declared column keys, so unlike the app-level tables this one is not generic
 * — which is why every alias below can be bound flat instead of staying generic
 * in `TData`.
 */
export type PanelRow = Record<string, unknown>;

export type PanelTableInstance = Table<PanelTableFeatures, PanelRow>;
export type PanelColumn = Column<PanelTableFeatures, PanelRow, unknown>;
export type PanelColumnDef = ColumnDef<PanelTableFeatures, PanelRow, unknown>;
export type PanelHeader = Header<PanelTableFeatures, PanelRow, unknown>;
export type PanelCell = Cell<PanelTableFeatures, PanelRow, unknown>;
export type PanelTableRow = Row<PanelTableFeatures, PanelRow>;

export { flexRender, useTable };
export type { ColumnFiltersState, ColumnVisibilityState, SortingState };
