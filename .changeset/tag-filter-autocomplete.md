---
'@dudousxd/nestjs-telescope-ui': minor
---

Turn the entries tag filter into an accessible autocomplete. Typing now queries
`GET /telescope/api/tags?prefix=` and surfaces matching tags with their entry
counts (top 10, sorted by count desc); picking one applies it as the active tag
filter and shows a clearable chip. Adds a `tags(prefix?)` client method and a
`useTags(prefix)` hook (non-polling reference data) plus the `TagCount` type.
