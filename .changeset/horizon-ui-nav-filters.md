---
'@dudousxd/nestjs-telescope-ui': minor
---

Add Laravel-Telescope-style per-type navigation and entry filtering to the
dashboard UI. The chrome is now a left sidebar with the existing top-level nav
(Overview, Entries, Pulse, Queues) plus a grouped "Watchers" section linking to
each entry type (Requests, Queries, Exceptions, Jobs, Mail, Cache, Schedule,
HTTP Client), each with a per-type color dot and routing to the entries list
pre-filtered to that type via `#/entries/<type>`. The entries list gains a
compact filter bar: an active-type chip with a clear affordance, a tag text
filter wired into the backend-supported `tag` query param, a "Clear filters"
control, and type/tag-aware empty states. Entry detail moves to
`#/entries/view/:id` to disambiguate from the per-type list route.
