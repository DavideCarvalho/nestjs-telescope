---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Traces list by keyset.

- `GET traces` no longer scans up to 50,000 entries of the window and groups them (a busy window came back `truncated`, with the traces at the cut partly counted, and nothing past the first page). It walks the entries newest-first only until it has the page's traces, asks for one more to know whether a next page exists (no second query, no count), then reads only those traces by `traceId`. On a 2.4M-entry PostgreSQL table (MikroORM), a 24-hour page takes about 50–70 ms at any depth instead of about 1.0–1.2 s for the only page there was.
- The response keeps `{ data, scanned, truncated }` and gains `nextCursor` and `hasNext`; `after=<nextCursor>` reads the next page. The cursor carries the last trace shown, so a trace that becomes active again is not shown twice. `TracesService.getTraces({ windowMs, limit, cursor })`; an invalid cursor is a 400. Ties on the same millisecond are ordered by trace id. `scanned` counts the entries read for the page.
- Trace rows show their request's "METHOD uri" label again on SQL stores (the content-less scan dropped it): the page's request entries are read by id.
- The Traces page pages with **Older** / **Newer**.
