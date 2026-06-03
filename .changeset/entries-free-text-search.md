---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Add free-text search over entries. `EntryQuery` gains a `search?: string` field —
a case-insensitive substring matched against the entry's serialized `content`, so
you can find a request by uri, a query by sql, a cache op by key, or an exception
by message. It is applied as an extra AND predicate, so it composes with every
other filter and with keyset pagination, and it is independent of `omitContent`
(the match runs over the stored content before any projection).

Every storage provider implements it: sqlite (`content LIKE '%term%'`), mikro-orm
(`raw('content')` `$like` so the JSON column is matched as text, not JSON-encoded),
in-memory and redis (case-insensitive substring over `JSON.stringify(content)` in
the predicate / in-scan post-filter). The `GET /entries` endpoint reads a non-empty
`search` query param, and the dashboard entries filter bar gains a "Search content"
input (commits on Enter/blur, never on keystroke) shown as a clearable
`search:"term"` chip that "Clear filters" drops.
