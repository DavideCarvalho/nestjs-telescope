---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

`Page` gains an optional `partial` flag, and the dashboard says when a listing is incomplete

A store sets `partial: true` on a `get()` page when it answered from a subset of its data — a tiered store whose cold tier could not be read returns its hot entries this way instead of failing. The flag is additive (absent means complete), passes through `GET /entries`, `GET /profiles` and the MCP `list_entries` tool, and the entries list shows a non-blocking notice that older entries are unavailable while the rows it did get stay usable.
