---
"@dudousxd/nestjs-telescope": patch
---

De-dupe the `/meta` watcher list. An extension that ships a watcher whose `type` equals its declared
entry-type id (durable/agent/diagnostics) landed in that list twice — once from `registered`, once
from `extensionTypes` — so the dashboard rendered a duplicate nav tab and the boot log double-counted
it. The list is now a `Set` (first-seen order preserved). Registration itself was always single;
only the surfaced list was affected.
