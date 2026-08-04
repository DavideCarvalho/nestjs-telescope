import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildPanelColumns } from './table-columns.js';
import { panelTableFeatures, useTable } from './table-features.js';

/**
 * v9 installs a feature's state slice and instance methods ONLY when that
 * feature is registered in `tableFeatures()`. An unregistered feature does not
 * fail loudly — the method is simply absent, which at the call site is
 * indistinguishable from "this API was removed in v9".
 *
 * So this asserts the inverse of the usual direction: not that the table behaves
 * correctly, but that every TanStack API the panel table actually calls exists
 * on a constructed instance. Deleting a feature from `table-features.ts` fails
 * here instead of blanking a dashboard panel.
 */

const columns = buildPanelColumns([
  { key: 'runId', label: 'Run', sortable: true, filterable: true, hideable: true },
  { key: 'status', label: 'Status' },
]);

const data = [
  { runId: 'zeta', status: 'ok' },
  { runId: 'alpha', status: 'failed' },
];

/** Built through `useTable`, the same entry point `PanelTable` uses, rather than
 *  core's `constructTable` — the latter needs the framework reactivity adapter
 *  that only the React binding supplies. */
function makeTable() {
  return renderHook(() =>
    useTable({
      features: panelTableFeatures,
      columns,
      data,
      manualSorting: true,
      manualFiltering: true,
    }),
  ).result.current;
}

describe('panelTableFeatures', () => {
  it('exposes every table method the panel table calls', () => {
    const table = makeTable();
    for (const method of [
      'getHeaderGroups',
      'getRowModel',
      'getAllLeafColumns',
      'getVisibleLeafColumns',
    ] as const) {
      expect(typeof table[method], `table.${method}`).toBe('function');
    }
  });

  it('exposes every column method the header and column menu call', () => {
    const [column] = makeTable().getAllLeafColumns();
    for (const method of [
      'getCanSort',
      'getIsSorted',
      'getToggleSortingHandler',
      'getCanFilter',
      'getFilterValue',
      'setFilterValue',
      'getCanHide',
      'getIsVisible',
      'toggleVisibility',
    ] as const) {
      expect(typeof column?.[method], `column.${method}`).toBe('function');
    }
  });

  it('exposes the row method the body calls', () => {
    const [row] = makeTable().getRowModel().rows;
    expect(typeof row?.getVisibleCells).toBe('function');
  });

  it('reports an opted-in column as sortable and filterable without a row model', () => {
    // Registering `rowSortingFeature`/`columnFilteringFeature` without their row
    // models is the whole design: both predicates key off `accessorFn`, not off a
    // registered model, so the header still renders its affordances while the
    // work happens on the server.
    const [column] = makeTable().getAllLeafColumns();
    expect(column?.getCanSort()).toBe(true);
    expect(column?.getCanFilter()).toBe(true);
    expect(column?.getCanHide()).toBe(true);
  });

  it('reports a column that opted into nothing as sortable/filterable/hideable: false', () => {
    // TanStack defaults all three to true. If `buildPanelColumns` ever stops
    // setting them explicitly, every column of every existing dashboard silently
    // grows controls whose provider does not implement them.
    const column = makeTable().getAllLeafColumns()[1];
    expect(column?.getCanSort()).toBe(false);
    expect(column?.getCanFilter()).toBe(false);
    expect(column?.getCanHide()).toBe(false);
  });

  it('keeps the provider row order — no client sorting is applied', () => {
    // The failure this guards: registering `createSortedRowModel` would re-order
    // the one page in hand and present it as the top of the whole result set.
    const table = makeTable();
    expect(table.getRowModel().rows.map((row) => row.original.runId)).toEqual(['zeta', 'alpha']);
  });
});
