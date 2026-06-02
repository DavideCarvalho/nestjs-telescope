# `@dudousxd/nestjs-telescope-redis` Storage Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A `RedisStorageProvider` implementing the core `StorageProvider` SPI over Redis (ioredis), so Telescope works across multiple replicas (shared, TTL-prunable storage). Fully testable here via `ioredis-mock` (no real Redis needed), with an optional real-Redis integration guarded by `skipIf(!REDIS_URL)`.

**Architecture / the key design:** Newest-first keyset pagination over Redis is made simple+correct by encoding each index member as a **single total lexicographic key** `inv(createdAtMs):id` where `inv = (MAX_MS - createdAtMs)` zero-padded to a fixed width (so newest = lexicographically smallest). Index ZSETs use `score = 0` and these lex members, and pagination is `ZRANGEBYLEX` (ascending = newest-first). The opaque cursor IS the last member string. `before`/`after`/cursor all become lex range bounds — no same-score edge cases, no offset math.

**SPI to implement** (`packages/core/src/storage/storage-provider.ts`): `store`, `update`, `find`, `get`, `batch`, `tags`, `prune`, `clear`, `close`. Reference the existing `InMemoryStorageProvider` + `SqliteStorageProvider` for exact semantics (newest-first by createdAt; `get` cursor returns entries strictly older than the cursor position; resumes if the cursor's entry was pruned; `after` = strictly newer; `before` = strictly older).

**Tech Stack:** TypeScript ESM/NodeNext strict, ioredis (peer), ioredis-mock (dev), vitest, biome, pnpm+turbo, changesets. Mirror the `packages/mikro-orm` package scaffold.

---

## Task 1: Scaffold `@dudousxd/nestjs-telescope-redis`
Mirror `packages/mikro-orm/package.json` (name/repo/author/license/scripts/tsconfig). Peer deps: `@dudousxd/nestjs-telescope` (workspace:*), `ioredis` (>=5). devDeps: core, `ioredis` ^5, `ioredis-mock` ^8, typescript/vitest/@types/node matching siblings. `src/index.ts` stub `export {}`. Copy `packages/mikro-orm/tsconfig.json`. Add the package to `.changeset/config.json` `linked`. `pnpm install`, build, `--passWithNoTests`, lint. Commit `chore(redis): scaffold @dudousxd/nestjs-telescope-redis`.

---

## Task 2: Lex key codec (pure, the correctness core)
**File:** `src/lex-key.ts` (+ spec).

Implement + TEST these pure helpers (the spec is the safety net for pagination correctness):
```ts
const WIDTH = 16; // digits; MAX_MS comfortably fits (Date max ~ 8.64e15 < 1e16)
const MAX_MS = 10 ** WIDTH - 1;
/** Newest-first lex member: smaller createdAt-inverse sorts first. */
export function lexMember(createdAtMs: number, id: string): string {
  const inv = (MAX_MS - createdAtMs).toString().padStart(WIDTH, '0');
  return `${inv}:${id}`;
}
/** Lower bound (exclusive) for "strictly newer than `afterMs`" → smaller-or-equal inv.
 *  after: createdAt > afterMs  → inv < inv(afterMs) → members lexicographically `< invKey(afterMs)`. */
export function invBound(createdAtMs: number): string {
  return (MAX_MS - createdAtMs).toString().padStart(WIDTH, '0');
}
```
Tests: newer createdAt → smaller member (sorts first); two ids same ts order by id; `invBound` monotonic (newer → smaller). These tests LOCK the ordering the pagination relies on. Commit `feat(redis): add lex-key codec for newest-first keyset pagination`.

---

## Task 3: `RedisStorageProvider` — store / find / batch / tags / clear / close
**File:** `src/redis-storage-provider.ts` (+ spec, using `ioredis-mock`).

Keys (prefix default `telescope:`, configurable via constructor opts): `e:<id>` (string, JSON entry); `idx` (ZSET score 0, members `lexMember(createdAt,id)`); `idx:type:<type>`, `idx:tag:<tag>`, `idx:family:<fh>` (same encoding); `batch:<batchId>` (ZSET score=sequence member=id); `tags` (HASH tag→count). Track index membership for prune/clear (e.g. also store the entry's index keys in a small set `e:<id>:idx`, or recompute from the entry on removal).

- `constructor(redis: Redis, options?: { keyPrefix?: string })` — accept an ioredis instance (host wires it); `ownsConnection=false` (don't close a host-supplied client unless constructed from opts — keep simple: never close a passed-in client; `close()` is a no-op unless we created it). Use explicit `@Inject`-free plain class (it's a StorageProvider, not a Nest provider).
- `store(entries)`: one pipeline — `SET e:<id>` JSON, `ZADD idx 0 <lexMember>`, type/tag/family index ZADDs, `ZADD batch:<batchId> <sequence> <id>`, `HINCRBY tags <tag> 1` per tag. exec.
- `find(id)`: GET e:<id> → parse (resilient JSON, like sqlite provider); `batch` = batch(entry.batchId). Return null if missing.
- `batch(batchId)`: `ZRANGE batch:<batchId> 0 -1` (by sequence asc) → MGET the entry JSONs → parse, drop missing.
- `tags(prefix?)`: `HGETALL tags` → filter by prefix → `{tag,count}[]` (count>0).
- `clear()`: scan+del all `<prefix>*` keys (use `SCAN` MATCH prefix*; or track a master set). ioredis-mock supports SCAN.
- `close()`: quit only if we own the connection (we don't for injected) — no-op for injected client.
Tests (ioredis-mock): store→find returns the entry+batch; batch ordered by sequence; tags counts + prefix filter; clear empties. Commit `feat(redis): RedisStorageProvider store/find/batch/tags/clear`.

---

## Task 4: `get` (lex keyset pagination) + `update` + `prune`
- `get(query)`: pick the source index key — `idx:type:<type>` if `query.type`, else `idx:tag:<tag>`, else `idx:family:<fh>`, else global `idx` (single primary filter; if MULTIPLE filters are set, use the primary + post-filter the fetched entries by the rest, refetching pages until `limit` filled or exhausted — note this in a comment; the dashboard uses single filters). Build the lex range: min = `(<cursorMember>` (exclusive) if cursor decodes, else `-`; apply `before`/`after` as additional lex bounds via `invBound` (`after` → max bound `(<invBound(afterMs)>`-style exclusive; `before` → min bound). `ZRANGEBYLEX key <min> <max> LIMIT 0 <limit+1>` → members; MGET their entry JSONs (member→id is the part after the first `:`); parse; `hasMore` if >limit; `nextCursor` = the last kept member (opaque). Decode `query.cursor` as a member string directly (the cursor IS the member). An undecodable/empty cursor → start from first page (`-`). If the cursor member was pruned, `ZRANGEBYLEX (cursor +` still resumes from that lex position — matches the SPI "resume" semantics naturally.
  - IMPORTANT: validate `limit` (default 50, positive int) like the other providers.
- `update(id, patch)`: GET e:<id>; if missing, return; merge `{...existing, ...patch, id}`; SET back. (If `createdAt` were patched the index would drift — patches don't change createdAt/id in practice; keep simple, note it.)
- `prune(olderThan, keepLast?)`: remove entries with `createdAt < olderThan`. Since members encode inv(createdAt), older = larger inv = lexicographically greater → `ZRANGEBYLEX idx (<invBound(olderThanMs)> +` gives the prune candidates (oldest). For each candidate id: DEL e:<id>, ZREM from idx + all its index ZSETs (recompute index keys from the entry before deleting, or read the entry first), HINCRBY tags down. `keepLast`: keep the newest `keepLast` of the pruned set (skip removing them). Return count removed. Mirror the in-memory prune semantics + return value.
Tests (ioredis-mock): get newest-first + cursor pagination across pages (store 120, page through with limit 50, assert order + no dupes + correct nextCursor); type filter; before/after window; update patches a field; prune removes old + returns count, keepLast retains N. Commit `feat(redis): RedisStorageProvider get (lex keyset) + update + prune`.

---

## Task 5: index export + optional real-Redis integration + README + changeset + verify
- `src/index.ts`: `export { RedisStorageProvider } from './redis-storage-provider.js';` + option types.
- Optional `src/redis-storage-provider.integration.spec.ts`: `describe.skipIf(!process.env.REDIS_URL)` running a subset of the suite against a REAL ioredis client (`new Redis(process.env.REDIS_URL)`), proving ioredis-mock parity. afterAll: flushdb + quit.
- `README.md`: usage — `const storage = new RedisStorageProvider(new Redis(url)); TelescopeModule.forRoot({ storage });`. Note multi-replica + that the host owns the connection.
- Root README packages table row (✅ shipped — "Redis-backed shared storage for multi-instance"). Changeset (`@dudousxd/nestjs-telescope-redis` minor).
- `pnpm build && pnpm test && pnpm lint` whole-repo green. Commit `docs(redis): export, README, changeset`.

---

## Self-Review
**Coverage:** full StorageProvider SPI over Redis (Tasks 3–4), with the lex-encoding making keyset pagination exact and simple (Task 2 locks it). Testable here via ioredis-mock; real-Redis parity optional (Task 5).
**Correctness risks:** (1) the lex `before`/`after`/cursor bound construction is the crux — Task 4's pagination tests (120 entries, multi-page, window, no-dupes) are the guard; get them GREEN. (2) prune must remove the entry from ALL its index ZSETs + decrement tag counts — read the entry first to know its tags/type/family. (3) multi-filter AND get() uses primary-index + post-filter; single-filter (the dashboard case) is exact. Note the AND limitation in code.
**YAGNI:** no Lua scripts, no TTL-on-keys (prune is explicit, matching the pruner service); a TTL mode is a future option.
