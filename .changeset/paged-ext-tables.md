---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Ext-dashboard tables paginate: a table panel may declare `paged: true` — the renderer adds
prev/next + "Page X of Y" and re-resolves the provider with `query.page`/`query.limit`, expecting
`{ rows, total, page, limit }`. Non-paged tables are byte-identical. `LinkSpec` documents the two
href conventions (in-app hash routes — including the trace view at `#/traces/{traceId}` — vs host
console paths); hash hrefs already navigate in-app.
