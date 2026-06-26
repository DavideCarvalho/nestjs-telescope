---
name: telescope-watchers
description: >-
  Capture sources in nestjs-telescope with watchers. Core auto-captures only
  request + exception; everything else is a Watcher added to the watchers[] array.
  Covers the Watcher / WatcherContext SPI, fire-and-forget ctx.record(RecordInput)
  and automatic batch correlation via AsyncLocalStorage, the built-in
  HttpClientWatcher (fetch + @nestjs/axios), the safeRecord try/catch rule, the
  instrument(emit, ctx) escape hatch, and wiring add-on watcher packages
  (mikro-orm, prisma, bullmq). Use for "capture queries/jobs/cache", "write a
  custom watcher", "correlate entries to a request".
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-telescope"
  library_version: "1.12.0"
  framework: nestjs
---

# Watchers & correlation

Telescope's core captures **only** requests and exceptions. Every other source —
queries, jobs, mail, cache, schedules, outbound HTTP — is a `Watcher` you add to
the `watchers` array. A watcher records inside the caller's async context, so its
entry lands in the right **batch** (the request or job that caused it) automatically.

## Setup

A watcher implements the `Watcher` interface and wires a framework hook in
`register()`:

```ts
import type { Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';

interface Watcher {
  readonly type: string;                                 // the entry `type` produced
  register(ctx: WatcherContext): void | Promise<void>;   // wire hooks, once at init
  shouldRecord?(candidate: unknown): boolean;            // optional cheap pre-filter
}

interface WatcherContext {
  record(input: RecordInput): void;                      // fire-and-forget; never await
  runInBatch<T>(origin: BatchOrigin, fn: () => Promise<T>): Promise<T>;
  beginBatch(origin: BatchOrigin): BatchHandle;
  readonly config: ResolvedCoreConfig;
  readonly moduleRef: ModuleRef;                         // resolve providers from DI
}
```

`RecordInput` is `{ type, content, familyHash?, tags?, durationMs?, startedAt? }`.
Everything else (id, batchId, sequence, traceId, …) is enriched by the recorder.

Source: `packages/core/src/nest/watcher.ts`, `packages/core/src/entry/entry.ts`,
`website/content/docs/recipes/custom-watcher.mdx`.

## Core patterns

### Pattern 1 — add the built-in HttpClientWatcher

Captures outbound HTTP. It instruments the global `fetch` with no peer dependency;
pass `axios` to also capture `@nestjs/axios` calls (which bypass `fetch`).

```ts
import { TelescopeModule, HttpClientWatcher } from '@dudousxd/nestjs-telescope';

TelescopeModule.forRoot({
  watchers: [new HttpClientWatcher({ slowMs: 1000 })],
});
```

Source: `packages/core/src/http/http-client.watcher.ts`,
`website/content/docs/getting-started.mdx`.

### Pattern 2 — a custom watcher with `ctx.record()`

Wire a hook in `register()`; call `ctx.record()` synchronously inside the host's
callback so correlation is automatic. Use `familyHash` to group like-with-like.

```ts
import type { RecordInput, Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';
import type { Server } from 'socket.io';

export class WebSocketWatcher implements Watcher {
  readonly type = 'websocket';
  constructor(private readonly io: Server) {}

  register(ctx: WatcherContext): void {
    const original = this.io.emit.bind(this.io);
    this.io.emit = (event: string, ...args: unknown[]): boolean => {
      this.safeRecord(ctx, event, args);
      return original(event, ...args);
    };
  }

  private safeRecord(ctx: WatcherContext, event: string, args: unknown[]): void {
    try {
      const input: RecordInput = {
        type: this.type,
        familyHash: `ws:${event}`, // groups identical events together
        content: { event, payloadBytes: Buffer.byteLength(JSON.stringify(args ?? [])) },
        tags: [`ws:${event}`],
      };
      ctx.record(input);
    } catch (error) {
      console.error(`WebSocketWatcher: failed to record: ${String(error)}`);
    }
  }
}

// TelescopeModule.forRoot({ watchers: [new WebSocketWatcher(io)] });
```

Source: `website/content/docs/recipes/custom-watcher.mdx`,
`packages/core/src/nest/watcher.ts`.

### Pattern 3 — wire an add-on watcher package (MikroORM)

Watcher add-ons are separate packages. The MikroORM query watcher is wired by
feeding its logger `telescope.record` from the injected `TelescopeService`:

```ts
import { TelescopeService } from '@dudousxd/nestjs-telescope';
import { telescopeMikroOrmLogger } from '@dudousxd/nestjs-telescope-mikro-orm';

MikroOrmModule.forRootAsync({
  inject: [TelescopeService],
  useFactory: (telescope: TelescopeService) => ({
    debug: ['query'],
    loggerFactory: telescopeMikroOrmLogger((input) => telescope.record(input)),
  }),
});
```

Source: `website/content/docs/getting-started.mdx`,
`packages/core/src/nest/telescope.service.ts` (`record`).

## Common mistakes

### Mistake 1 — awaiting `ctx.record()`

```ts
// Wrong — record() returns void; awaiting it is meaningless and misleading.
await ctx.record(input);
```

```ts
// Correct — fire-and-forget; it never throws and never blocks.
ctx.record(input);
```

Mechanism: `record()` hands the entry to the buffered Recorder and returns
synchronously; it is `void` by design so capture never sits on the response path.
Source: `packages/core/src/nest/watcher.ts`.

### Mistake 2 — opening a batch in an ordinary watcher

```ts
// Wrong — a non entry-point watcher should NOT open a batch; it breaks correlation
// by starting a fresh batch instead of joining the active request/job batch.
register(ctx: WatcherContext) {
  this.cache.on('hit', (k) => ctx.runInBatch('manual', async () => ctx.record({ type: 'cache', content: { k } })));
}
```

```ts
// Correct — just record(); the active request/job ALS scope stamps the batch id.
register(ctx: WatcherContext) {
  this.cache.on('hit', (k) => ctx.record({ type: 'cache', content: { key: k } }));
}
```

Mechanism: only entry-point watchers (HTTP, queues, schedules) open a batch with
`runInBatch`/`beginBatch`; downstream events simply `record()` inside the caller's
async context. Source: `website/content/docs/recipes/custom-watcher.mdx`,
`packages/core/src/nest/watcher.ts`.

### Mistake 3 — building entry content outside a try/catch

```ts
// Wrong — JSON.stringify of a circular/huge payload throws on the HOST thread and
// can break the very operation you are observing.
this.io.emit = (event, ...args) => {
  ctx.record({ type: 'ws', content: { bytes: JSON.stringify(args).length } });
  return original(event, ...args);
};
```

```ts
// Correct — guard the content-building in a safeRecord wrapper.
this.io.emit = (event, ...args) => {
  this.safeRecord(ctx, event, args); // try/catch inside
  return original(event, ...args);
};
```

Mechanism: `ctx.record` swallows recorder-side failures, but YOUR content-building
runs on the host's thread, so a watcher must never let it throw into the host code
path. Source: `website/content/docs/recipes/custom-watcher.mdx`.
