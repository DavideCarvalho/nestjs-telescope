---
name: telescope-storage-retention
description: >-
  Storage, retention, redaction, and sampling in nestjs-telescope. Swap the default
  per-process SQLite store for a shared adapter (RedisStorageProvider) so a
  multi-instance deployment aggregates the whole cluster; implement the
  StorageProvider SPI (store/get/find/batch/prune/pruneScoped?/markFamilySeen?);
  configure prune.after + prune.perType retention; export-before-prune with
  archive.{types,sink,batchSize}; mask sensitive data with redact.{keys,paths,mask};
  tail-sample with sampling rules that always keep errors/slow entries. Use for
  "multi-instance dashboard", "custom storage", "S3 archive", "redact secrets",
  "per-type retention".
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-telescope"
  library_version: "1.12.0"
  framework: nestjs
---

# Storage, retention & redaction

Telescope persists entries through a pluggable `StorageProvider`. The default is a
per-process in-memory SQLite store — perfect for local dev, wrong for a cluster.
Retention (`prune`), export-before-delete (`archive`), masking (`redact`), and
`sampling` all sit on `forRoot`.

## Setup

Swap to a shared store so every replica reads/writes one place and the dashboard
shows the whole cluster:

```ts
import Redis from 'ioredis';
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { RedisStorageProvider } from '@dudousxd/nestjs-telescope-redis';

TelescopeModule.forRoot({
  storage: new RedisStorageProvider(new Redis(process.env.REDIS_URL!)),
  prune: { after: '24h' },
});
```

Source: `website/content/docs/getting-started.mdx`,
`packages/redis/src/index.ts`, `packages/core/src/storage/storage-provider.ts`.

## Core patterns

### Pattern 1 — per-type retention

`prune.perType` overrides `after` for specific entry types; absent types fall back
to the global `after`. Keys are entry types (`'exception'`, `'request'`, …).

```ts
TelescopeModule.forRoot({
  prune: {
    after: '24h',                 // global default
    intervalMs: 60_000,
    perType: { exception: '7d' }, // keep exceptions a week, everything else 24h
  },
});
```

An unparseable duration is a boot error, not a silent skip.
Source: `packages/core/src/config/options.ts` (`PruneOptions.perType`).

### Pattern 2 — archive before prune (S3)

`archive` streams doomed entries to a host-owned `sink` BEFORE the pruner deletes
them. Only the listed `types` are archived; the type is deleted ONLY after the sink
resolves. A rejecting sink keeps those entries for next cycle (never crashes).

```ts
TelescopeModule.forRoot({
  prune: { after: '24h', perType: { exception: '30d' } },
  archive: {
    types: ['exception'],
    batchSize: 500,
    sink: async (entries) => {
      await s3.putObject({
        Bucket: 'telescope-archive',
        Key: `exceptions/${Date.now()}.json`,
        Body: JSON.stringify(entries),
      });
    },
  },
});
```

Source: `packages/core/src/config/options.ts` (`ArchiveOptions`),
`website/content/docs/recipes/archiving-exceptions-to-s3.mdx`.

### Pattern 3 — redaction and tail-sampling

Redaction is always on. `keys` merge with `DEFAULT_REDACT_KEYS` (matched at any
depth); `paths` are exact dot-paths. `sampling` can be a bare keep-rate or a rule
that always retains errors / slow entries.

```ts
TelescopeModule.forRoot({
  redact: { keys: ['ssn', 'apiKey'], paths: ['body.creditCard'], mask: '[hidden]' },
  sampling: {
    request: { rate: 0.1, keepErrors: true, keepSlowMs: 1000 }, // keep 10%, but all errors/slow
    query: 0.25,                                                 // bare rate
  },
});
```

Source: `packages/core/src/redaction/redact.ts` (`RedactOptions`,
`DEFAULT_REDACT_KEYS`), `packages/core/src/config/options.ts` (`SamplingRule`).

## Common mistakes

### Mistake 1 — running the default SQLite store across replicas

```ts
// Wrong — the default store is per-process; in a 3-pod deploy the dashboard only
// shows entries from whichever pod served the request.
TelescopeModule.forRoot({ prune: { after: '24h' } });
```

```ts
// Correct — share one store so the dashboard aggregates the cluster.
TelescopeModule.forRoot({
  storage: new RedisStorageProvider(new Redis(process.env.REDIS_URL!)),
});
```

Mechanism: the default `SqliteStorageProvider(':memory:')` lives in one process;
multi-instance needs a shared adapter (Redis / MikroORM).
Source: `website/content/docs/getting-started.mdx`,
`packages/core/src/nest/telescope.options.ts` (`storage` default).

### Mistake 2 — a custom provider whose `init()` schema work isn't awaited at boot

```ts
// Wrong — kicking off schema setup without returning the promise; queries race
// the half-built schema because the module won't await it.
class MyProvider implements StorageProvider {
  init() { this.createTables(); } // fire-and-forget, returns void
  /* ... */
}
```

```ts
// Correct — return the promise from init(); the module awaits it before any other call.
class MyProvider implements StorageProvider {
  async init() { await this.createTables(); }
  /* ...store/get/find/batch/prune... */
}
```

Mechanism: `init()` is called ONCE at boot, before any other method, and is
awaited by the module — so it must return its promise. Source:
`packages/core/src/storage/storage-provider.ts` (`StorageProvider.init`).

### Mistake 3 — configuring `archive` without `prune`

```ts
// Wrong — archive only fires for entries the pruner is about to delete; with no
// prune nothing is ever doomed, so the sink never runs.
TelescopeModule.forRoot({
  archive: { types: ['exception'], sink: shipToS3 },
});
```

```ts
// Correct — archive is meaningful only alongside prune.
TelescopeModule.forRoot({
  prune: { after: '24h' },
  archive: { types: ['exception'], sink: shipToS3 },
});
```

Mechanism: archiving is "export THEN delete, per type, per cycle" driven by the
pruner; with no pruning there is nothing doomed to export. Source:
`packages/core/src/config/options.ts` (`ArchiveOptions` / `TelescopeCoreOptions.archive`).
