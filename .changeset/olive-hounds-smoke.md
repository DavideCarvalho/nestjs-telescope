---
'@dudousxd/nestjs-telescope-ui': patch
---

Stop an extension dashboard's tables from painting outside their cards.

A `table` panel was the one surface in the console still rendering hand-rolled `<table>` markup:
it never moved onto the vendored shadcn `Table` when that primitive landed, so it also never got
the scroll container the primitive brings. That matters because a section lays its panels out as
a `grid-cols-N` of equal cells, and a card is routinely narrower than the table inside it — a
7-column table in a `cols: 3` section. `w-full` is only a *preferred* width: `table-layout: auto`
still lays the table out at its min-content width, and with nothing clipping it the remaining
columns painted over the neighbouring panel.

Measured on flip's `durable.workflows` dashboard: a 379px card holding a 633px "Worker health"
table (its `STATUS` column landed on top of the panel to its right), and a 575px card holding a
1154px "Workers" table. `agent.overview` had the same break — `COST (USD)` and `LAST ACTIVITY`
rendered outside their cards.

- Both table variants, paged and not, now render through `Table`/`TableHeader`/`TableBody`/
  `TableRow`/`TableHead`/`TableCell`, so a table too wide for its card scrolls inside it and
  every panel keeps the same row height, header casing and divider colour as the rest of the app.
- Cells are `whitespace-nowrap`. Wrapping is what turned durable's "Workers" panel into
  three-line rows; with a scroller in place, a long worker id belongs on one line behind a
  scrollbar.
- The pager's prev/next are the vendored `Button` (`outline`/`xs`) rather than bare `<button>`s.
