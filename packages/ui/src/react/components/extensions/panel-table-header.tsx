import { type JSX, useEffect, useState } from 'react';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { TableHead, TableHeader, TableRow } from '../../ui/table.js';
import { type PanelHeader, type PanelTableInstance, flexRender } from './table-features.js';

/** The three sort states a header can be in, as a glyph. `↕` is the "you can
 *  sort by this" affordance, dimmed so it reads as available rather than active. */
function SortIndicator({ direction }: { direction: false | 'asc' | 'desc' }): JSX.Element {
  if (direction === 'asc') return <span aria-hidden="true">↑</span>;
  if (direction === 'desc') return <span aria-hidden="true">↓</span>;
  return (
    <span aria-hidden="true" className="opacity-30">
      ↕
    </span>
  );
}

/**
 * A sortable column's header: the vendored ghost `Button` plus a direction
 * glyph, wired to TanStack's own `getToggleSortingHandler()` so the
 * ascending → descending → unsorted cycle is the library's and not a
 * hand-rolled one that drifts from it.
 *
 * `aria-sort` goes on the `<th>` rather than the button — that is where assistive
 * tech looks for it, and it is the only thing that tells a screen-reader user
 * the table is sorted at all, since the direction itself is a decorative glyph.
 */
function SortableHead({
  header,
  className,
}: {
  header: PanelHeader;
  className: string;
}): JSX.Element {
  const direction = header.column.getIsSorted();
  const label = flexRender(header.column.columnDef.header, header.getContext());
  return (
    <TableHead
      className={`whitespace-nowrap p-0 ${className}`}
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
    >
      <Button
        variant="ghost"
        size="xs"
        onClick={header.column.getToggleSortingHandler()}
        className="w-full justify-start gap-1 px-3 py-2 font-normal"
      >
        {label}
        <SortIndicator direction={direction} />
      </Button>
    </TableHead>
  );
}

/**
 * A filter box for one column.
 *
 * Draft state is local and only committed on Enter or blur. A live-as-you-type
 * filter looks nicer and is the wrong shape here: every keystroke would be a
 * fresh provider resolve, i.e. a query against whatever store the extension
 * sits on, for a string the user has not finished typing. Committing is also
 * what makes "clear the box" mean "drop the filter" rather than "match the
 * empty string".
 */
function ColumnFilterInput({ header }: { header: PanelHeader }): JSX.Element {
  const applied = header.column.getFilterValue();
  const appliedText = typeof applied === 'string' ? applied : '';
  const [draft, setDraft] = useState(appliedText);

  // The applied value can change underneath the box — another panel control
  // resets it, or the dashboard remounts with a different filter. Re-seed the
  // draft from it, or the box would keep showing a filter that is no longer on.
  useEffect(() => setDraft(appliedText), [appliedText]);

  const commit = (): void => {
    if (draft === appliedText) return;
    header.column.setFilterValue(draft);
  };

  return (
    <Input
      value={draft}
      aria-label={`Filter by ${header.column.id}`}
      placeholder="Filter…"
      className="w-full py-0.5"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') setDraft(appliedText);
      }}
    />
  );
}

/**
 * A table panel's `<thead>`: the label row, plus a filter row when at least one
 * column declared `filterable`.
 *
 * `sticky` is passed only for paged tables, whose body is height-capped and
 * scrolls; the classes go on the `<th>`s rather than the `<thead>` because a
 * `border-collapse: collapse` table (which the vendored `Table` is) does not
 * honour `position: sticky` on a section element in every browser.
 */
export function PanelTableHeader({
  table,
  sticky,
  menu,
}: {
  table: PanelTableInstance;
  sticky: boolean;
  /** The column-visibility menu, rendered in its own trailing cell when present. */
  menu?: JSX.Element | null;
}): JSX.Element {
  const headers = table.getHeaderGroups().at(-1)?.headers ?? [];
  const anyFilterable = headers.some((header) => header.column.getCanFilter());
  // The filter row sticks BELOW the label row, hence the second offset — both
  // rows have to stay put or the one that scrolls away takes its controls with it.
  //
  // `bg-panel` and not the card's own `bg-panel/40`: a pinned header has rows
  // passing underneath it, and a translucent one shows them through.
  const stickyClass = sticky ? 'sticky top-0 z-10 bg-panel' : '';
  const stickyFilterClass = sticky ? 'sticky top-8 z-10 bg-panel' : '';

  return (
    <TableHeader>
      <TableRow>
        {headers.map((header) =>
          header.column.getCanSort() ? (
            <SortableHead key={header.id} header={header} className={stickyClass} />
          ) : (
            <TableHead key={header.id} className={`whitespace-nowrap ${stickyClass}`}>
              {flexRender(header.column.columnDef.header, header.getContext())}
            </TableHead>
          ),
        )}
        {menu ? (
          <TableHead className={`w-px whitespace-nowrap text-right ${stickyClass}`}>
            {menu}
          </TableHead>
        ) : null}
      </TableRow>
      {anyFilterable && (
        <TableRow>
          {headers.map((header) => (
            <TableHead key={header.id} className={`py-1 ${stickyFilterClass}`}>
              {header.column.getCanFilter() ? <ColumnFilterInput header={header} /> : null}
            </TableHead>
          ))}
          {menu ? <TableHead className={stickyFilterClass} /> : null}
        </TableRow>
      )}
    </TableHeader>
  );
}
