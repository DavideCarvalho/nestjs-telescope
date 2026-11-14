---
'@dudousxd/nestjs-telescope-ui': major
---

**Breaking: the client speaks the Aviary list API of `@dudousxd/nestjs-telescope` 5, and needs it.**

- `client.entries({ type, tag, traceId, batchId, familyHash, search, after, first })` sends `filter[...]` / `after` / `first` (was `cursor` / `limit`) and resolves `{ data, meta, partial? }`; `Page<T>` is now `{ data, meta: CursorPageMeta, partial? }` (was `{ data, nextCursor, partial? }`). New types `CursorPage`, `CursorPageMeta`, `OffsetPage`, `OffsetPageMeta`, `CursorPageRequest`.
- `client.tags(prefix, { search, after, first })` resolves `CursorPage<TagCount>` (was `TagCount[]` with `limit` / `offset`).
- `client.queueJobs(driver, queue, state, { after, first })` resolves `CursorPage<QueueJob>` (was `JobPage` with `cursor` / `limit`); `JobPage` is no longer re-exported from `./client`.
- `client.traces(window, size)` resolves `{ data, scanned, truncated }` (was `{ traces, … }`, `limit`).
- `client.profiles({ after, first })` (was `profiles(limit)`).
- `client.ai(window, { buckets, top, size })` (was `limit`).
- Extension table panels send `page` / `size` / `sort=-col` / `filter[col]` and read the offset list `{ data, meta }` (was `page` / `limit` / `sort` + `dir` / `filter.col` and `{ rows, total, page, limit }`). `buildTableQuery`'s `paging` is `{ page, size }`.
- `useTraces(window, size)`, `useProfiles(first)`, `useQueueJobs(…, { after, first })`; `useTagsInfinite` pages by cursor.
