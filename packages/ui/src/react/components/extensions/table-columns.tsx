import type { JSX } from 'react';
import type { Panel } from '../../../client/types.js';
import type { PanelColumnDef, PanelRow } from './table-features.js';

/** The `table` panel variant's column shape, pulled from the discriminated union
 *  rather than re-declared, so it can never drift from `Panel`. */
export type TableColumnSpec = Extract<Panel, { kind: 'table' }>['columns'][number];

/**
 * Fills a `{key}` link template from a row.
 *
 * The template is author-controlled but the substituted values come from
 * provider row data — never let a row turn the link into a `javascript:`/`data:`
 * URL.
 */
export function fillTemplate(href: string, row: PanelRow): string {
  const filled = href.replace(/\{(\w+)\}/g, (_m, k: string) => String(row[k] ?? ''));
  if (/^\s*(javascript|data|vbscript):/i.test(filled)) return '#';
  return filled;
}

/** A cell's rendered content: the row's value for this column, as a deep link
 *  when the column declares one. A fragment, not an element, so the markup
 *  inside the `<td>` is exactly what it was before the table grew a table
 *  instance around it. */
function CellContent({ spec, row }: { spec: TableColumnSpec; row: PanelRow }): JSX.Element {
  const text = String(row[spec.key] ?? '');
  if (!spec.link) return <>{text}</>;
  return (
    <a
      className="text-sky-400 hover:underline"
      href={fillTemplate(spec.link.href, row)}
      {...(spec.link.external ? { target: '_blank', rel: 'noreferrer' } : {})}
    >
      {text}
    </a>
  );
}

/**
 * Translates a panel's declared columns into TanStack column definitions.
 *
 * `accessorFn` rather than `accessorKey`: a key is parsed as a *deep* path, so a
 * provider returning a flat row keyed `'queue.name'` would resolve to
 * `row.queue.name` and render blank. It also has to be present at all — both
 * `getCanSort()` and `getCanFilter()` key off the accessor, not off a
 * registered row model, which is what lets the header show sort and filter
 * affordances for state that is resolved on the server.
 *
 * Each `enable*` is set explicitly from the spec because TanStack defaults all
 * three to `true`: left off, every column of every existing dashboard would
 * suddenly be sortable, filterable and hideable, promising behaviour no
 * provider implements.
 */
export function buildPanelColumns(specs: TableColumnSpec[]): PanelColumnDef[] {
  return specs.map((spec) => ({
    id: spec.key,
    accessorFn: (row: PanelRow) => row[spec.key],
    header: spec.label,
    enableSorting: spec.sortable === true,
    enableColumnFilter: spec.filterable === true,
    enableHiding: spec.hideable === true,
    cell: ({ row }: { row: { original: PanelRow } }) => (
      <CellContent spec={spec} row={row.original} />
    ),
  }));
}
