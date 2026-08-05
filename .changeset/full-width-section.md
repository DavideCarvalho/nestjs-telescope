---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Let a dashboard section declare `cols: 1` — the full-width row.

A section renders as a fixed `grid-cols-N` grid, one panel per cell, with no `colSpan`, and `cols`
only accepted `2 | 3 | 4`. So the widest panel a dashboard has — a table with ten or more columns —
could not be given a row of its own. Declared in the narrowest grid available it still got half the
viewport, scrolled sideways inside its own card, and left the cell beside it empty.

That is not hypothetical: `@dudousxd/nestjs-durable-telescope` ships its eleven-column worker table
as the only panel of a `cols: 2` section, which on a 1418px viewport rendered a 1406px table into a
575px card with a hole next to it. There was no way to express the fix.

Additive: `cols` gains `1`, existing values behave identically, and the grid needs no new responsive
class for it — it is already `grid-cols-1` at every breakpoint, so a full-width row is the absence
of an override rather than the presence of one.
