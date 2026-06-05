---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Add user drill-down: pivot from any request entry to all of a user's activity.

A new built-in **`userTagger`** (in `BUILTIN_TAGGERS`) tags request entries with
the authenticated user's identity as `user:<id>`. It reads `content.user`,
preferring `id`, then `_id` (Mongo), then `email` — cheap property reads gated to
request entries, never throwing on odd content shapes. Whatever `resolveUser`
returns becomes a filterable tag.

The dashboard turns that tag into a one-click pivot, reusing the existing
indexed-tag filter (no new query dimension): user-tagged rows show a `user:<id>`
chip in the entries table, and the entry detail view offers **"View all activity
for this user"**. Both navigate to the all-types entries list pre-filtered by the
tag (`#/entries?tag=user:<id>`), which the entries page now seeds from the `?tag=`
query string — the same deep-link mechanism as `?familyHash=`.
