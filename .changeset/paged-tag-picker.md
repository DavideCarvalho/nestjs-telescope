---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

The tag filter is a picker over what exists — searched and paged on the server

It was a text box with suggestions bolted on: it showed nothing until you typed, asked the server for
a **prefix** match, and then re-filtered and sliced the answer to ten in the browser. So it could
only suggest tags whose first characters you already knew, and the ten it kept were the ten it
happened to fetch.

- **Focus opens it.** The list is the answer to "what can I filter by", and requiring a first
  character asks an operator to guess that answer before seeing it.
- **`search` matches anywhere in the tag** and runs on the server, before the bound. A picker that
  narrowed its own fetched page could only ever find what the bound already let through — and on a
  deployment with real tag cardinality, the bound is precisely what hides the value being looked for.
- **The list pages as it scrolls**, so the bound is a window rather than a ceiling.
- Typing something the list does not offer still applies as typed. A bounded list has to stay
  escapable.

`GET /tags` gains `search`, `limit` and `offset`; `StorageProvider.tags` gains an optional `TagQuery`
and now promises an order (count descending, ties alphabetical) — an unordered listing cannot be
paged, because page two would be cut from a different arrangement of the same rows. A provider that
ignores the query stays correct: the controller re-applies the page, so a picker never renders more
than it asked for.
