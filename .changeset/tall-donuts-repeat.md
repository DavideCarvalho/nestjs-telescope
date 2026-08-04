---
'@dudousxd/nestjs-telescope-ui': minor
'@dudousxd/nestjs-telescope': minor
---

Rebuild the extension-dashboard `table` panel on TanStack Table v9, and give it server-side sort
and filter.

A table panel could only ever be read. Sorting it was not an oversight so much as an unanswered
question: the panel holds the one page its provider returned, so a sort added in the browser would
have ordered 50 rows out of 50,000 and presented the result as "the slowest runs" — a control that
is wrong precisely when someone is relying on it. The answer here is that the choice goes back to
the provider, which is the only party that can see the whole result set.

**The new SPI** (additive; existing panels and providers are untouched). A column opts in:

```ts
columns: [
  { key: 'runId', label: 'Run', filterable: true },
  { key: 'duration', label: 'Duration', sortable: true },
  { key: 'worker', label: 'Worker', hideable: true },
]
```

- `sortable` — the header becomes a button cycling ascending → descending → unsorted, and the
  provider is re-resolved with `sort=<key>` + `dir=asc|desc` (both absent when unsorted).
- `filterable` — a filter box appears under the header, committed on Enter or blur, sent as
  `filter.<key>=<text>`. Namespaced because a panel scoped to `{ status: 'running' }` carrying a
  filterable `status` column is an ordinary combination, and unprefixed one would silently
  overwrite the other.
- `hideable` — the column joins the panel's **Columns** menu. Display-only; it never reaches the
  provider, and the menu is absent entirely when no column opts in.

Providers read the state with the new `readTableQuery(query)` from `@dudousxd/nestjs-telescope`,
which returns `{ page?, limit?, sort?: { key, dir }, filters }`. Reading it by hand is the trap it
exists to close: every value arrives as a **string** off the URL, so `query.page > 1` is silently
`false` for `'2'`, and `?page=banana` reaches a `LIMIT` clause as `NaN`. It also drops an emptied
filter box (`filter.status=` means *no* filter, not "match the empty string") and reads an
unrecognized direction as ascending.

Backward compatibility is the point, not a footnote: a provider that ignores the new params behaves
exactly as before, and a panel whose columns declare none of the three flags renders the identical
table — no header buttons, no filter row, no column menu, and the byte-identical query on the wire.
The query builder returns the panel's own `data.query` *by identity* when there is nothing to merge,
so existing dashboards do not even move to a new React Query cache key.

- **v9's explicit feature model.** `table-features.ts` is the package's only module that imports
  `@tanstack/react-table`; everything else consumes the hook, `flexRender` and the pre-bound types
  through it. v9 installs a feature's state and instance methods only when it is registered, and an
  unregistered feature is not an error — the method is simply gone, which at the call site is
  indistinguishable from "removed in v9". A contract spec asserts every API the table actually calls.
- **No client row models are registered**, deliberately. `createSortedRowModel` and friends would
  re-do server-side work over the single page in hand, which is the exact failure this change exists
  to avoid. `rowPaginationFeature` and `columnSizingFeature` are left out too — the pager is driven
  by what the provider returned, and column sizing would default every column of every dashboard to
  a fixed 150px.
- **A paged table's rows now scroll under a pinned header**, capped at 28rem. A 50-row page was
  otherwise a ~1,500px card that pushed every panel below it off screen, and by row 40 the column
  labels were long gone. A short page never reaches the cap and is unchanged.
- The vendored `Table` primitive gains `containerClassName`. That wrapper div is already a scroll
  container, so it is the element a sticky header positions against — a `max-h-*` applied anywhere
  further out gives a scrolling ancestor the sticky cells cannot see.
- `@tanstack/react-table` is declared as an optional peer dependency, alongside `recharts` and
  `@tanstack/react-query`: the bundled SPA carries its own copy, so only a host composing these
  React components itself needs to install it.
