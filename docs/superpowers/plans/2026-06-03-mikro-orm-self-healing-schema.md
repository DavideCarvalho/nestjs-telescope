# MikroOrmStorageProvider self-healing schema (dedicated ORM) — Implementation Plan

> **For agentic workers:** execute via superpowers:subagent-driven-development, task-by-task, commit per task.

**Goal:** Make `MikroOrmStorageProvider` own a dedicated MikroORM scoped to `[TelescopeEntry]` that self-heals its schema at boot (create table + add missing columns, additive-only, never drop), getting its connection by default from the host's existing ORM or, optionally, from explicit connection config.

**Why dedicated connection (not host `em`):** (1) schema diff (`schema.update`) has no per-entity filter, so to never touch host tables the diff must run on an ORM that only knows `TelescopeEntry`; (2) running storage I/O on the host ORM (which has the telescope query logger wired) causes a self-capture feedback loop — every `INSERT INTO telescope_entries` during flush is captured as a `query` entry, recorded, flushed, re-captured. A separate connection the host's `loggerFactory` doesn't wrap eliminates both.

**Tech:** MikroORM v7 SchemaGenerator (`ensureDatabase()`, `update({ safe: true })`), `MikroORM.init`, `orm.config.getAll()` to derive host connection.

---

## Task 1: Core SPI — `init?()` + always-close lifecycle

**Files:**
- Modify: `packages/core/src/storage/storage-provider.ts`
- Modify: `packages/core/src/nest/telescope.service.ts`
- Modify: `packages/core/src/nest/telescope.service.spec.ts`

- Add optional `init?(): void | Promise<void>` to `StorageProvider` ("Acquire resources / ensure schema once at boot, before first use. The module awaits this during startup.").
- Refine `close?()` doc: "Release provider-OWNED resources at shutdown. Must no-op if the provider borrows a host-owned resource (e.g. a shared connection). The module always calls this after the final flush."
- `TelescopeService.onModuleInit`: make `async`; when `config.enabled`, `await this.storage.init?.()` BEFORE starting the flush timer.
- `TelescopeService.onApplicationShutdown`: after the final flush, ALWAYS `await this.storage.close?.()` (remove the `if (!this.options.storage)` gate).
- Update the two close tests in `telescope.service.spec.ts`: the old "does NOT call close when host supplied" test inverts → now it DOES call close regardless of supplier; add/adjust an init test (storage.init is awaited at boot when enabled). Keep the "close AFTER flush" ordering assertion.

Verify: `cd packages/core && pnpm test && pnpm typecheck`. Commit `feat(core): add StorageProvider.init() boot hook + always-close lifecycle`.

## Task 2: Rewrite `MikroOrmStorageProvider` to a dedicated scoped ORM + tests

**Files:**
- Modify: `packages/mikro-orm/src/mikro-orm-storage.provider.ts`
- Modify: `packages/mikro-orm/src/mikro-orm-storage.provider.integration.spec.ts`

- Ctor accepts a discriminated input:
  - a `MikroORM` instance → derive connection options from `hostOrm.config.getAll()` (driver + connection: clientUrl/dbName/host/port/user/password/schema/driverOptions/pool), default path.
  - OR an explicit options object `{ ...mikroConnectionOptions, ensureSchema?: boolean }` → use as given.
- Build (in `init()`) a scoped `MikroORM.init({ <connection>, entities: [TelescopeEntry], allowGlobalContext: true, discovery: { disableDynamicFileAccess: true } })`; store as `this.orm`.
- `init()`: connect scoped ORM; if `ensureSchema !== false` (default true) → `await orm.schema.ensureDatabase(); await orm.schema.update({ safe: true })`.
- All I/O via `this.orm.em.fork()` (provider is not usable before `init()`; guard with a clear error if `this.orm` is null).
- `close()`: `await this.orm?.close(true)`.
- Tests (real MikroORM, SqliteDriver `:memory:` — note `:memory:` is per-connection, so explicit-config tests must share one ORM; for the derive-from-host path, init a host ORM with a sibling entity + TelescopeEntry, pass it, assert telescope_entries created and the sibling table untouched). Cover: init creates the table; **additive** — pre-create a `telescope_entries` missing a column, init adds it, never drops; **isolation** — a sibling host table with a column the entity lacks is NOT altered; explicit-config path; the 120-entry keyset guard still passes (now after `await provider.init()`); CRUD/filters/prune/tags all green post-init.

Verify: `cd packages/mikro-orm && pnpm test && pnpm typecheck && pnpm build`. Commit `feat(mikro-orm): dedicated scoped ORM with self-healing schema (ensureSchema)`.

## Task 3: Docs + changeset

**Files:** `packages/mikro-orm/README.md`, `.changeset/mikro-orm-storage.md` (amend) or a new changeset.

- README storage section: new ctor (pass host `MikroORM` by default, or explicit config), `ensureSchema` (default true, additive/safe, never drops), the separate-connection rationale (no self-capture + safe schema scoping + write-load isolation), and that no migration is needed.
- Changeset: bump core (minor, init() hook) + mikro-orm (minor).

Verify: `pnpm -w build`. Commit `docs(mikro-orm): document self-healing schema + dedicated connection`.

## Task 4: flip rewiring + build (branch `telescope-local`)

**Files:** `~/goflipai/flip-nestjs/src/app.module.ts` (+ repack tarball, reinstall).

- `telescopeOptionsFactory(orm)`: return `{ storage: new MikroOrmStorageProvider(orm) }` (pass the MikroORM, not `orm.em`). Keep the `instanceof MikroORM` guard.
- Repack core + mikro-orm tarballs (both changed), bump the `mikro-orm-local.tgz` cache-bust path if needed, `pnpm install`, `./node_modules/.bin/nest build` (exit 0).
- The manual `telescope_entries` table step is GONE (auto at boot). Commit on `telescope-local`.
