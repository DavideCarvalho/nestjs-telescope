# @dudousxd/nestjs-telescope-mikro-orm-watcher

Model watcher for [`@dudousxd/nestjs-telescope`](../../README.md). Captures every
MikroORM entity lifecycle change (create / update / delete) and records one
`model` entry per change, correlated to the request or job that triggered the
flush.

The watcher resolves your app's `MikroORM` singleton from the Nest container and
registers an `EventSubscriber` on the EntityManager's event manager. Each
`afterCreate` / `afterUpdate` / `afterDelete` hook records
`{ action, entity, id, changes }`. The subscriber runs in the flushing async
context, so each captured entry lands in the active request/job batch
automatically. No batch is opened here.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-mikro-orm-watcher
```

`@mikro-orm/core` is an **optional** peer dependency — you already have it if your
app uses MikroORM. If `MikroORM` can't be resolved (or has no event manager), the
watcher logs a warning and no-ops; it never throws.

## Usage

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { MikroOrmModelWatcher } from '@dudousxd/nestjs-telescope-mikro-orm-watcher';

TelescopeModule.forRoot({
  watchers: [new MikroOrmModelWatcher()],
});
```

Each captured entry has type `model` and `ModelContent`:

```ts
{
  action: 'create' | 'update' | 'delete';
  entity: string;                          // entity class name
  id: string | null;                       // primary key, null when unassigned
  changes: Record<string, unknown> | null; // change set payload (null on delete)
}
```

`changes` is redacted by the Recorder like any other content.

## Feedback-loop guard

Telescope's own storage entities (`TelescopeEntry` / `TelescopeRollup`) are
skipped by class name, so persisting an entry never records another `model`
entry.

## License

MIT © Davi Carvalho
