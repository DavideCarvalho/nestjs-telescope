# @dudousxd/nestjs-telescope-observe

> Forwards [@dudousxd/nestjs-telescope](https://github.com/DavideCarvalho/nestjs-telescope)
> entries to [NestJS Observe](https://observe.nestjs.com), so the same capture
> that feeds your in-app dashboard also feeds their hosted one.

**Status:** early development (`0.0.0`). Requires an Observe project API key.

## Why this exists

Observe's own SDK instruments by proxying every provider in the Nest container.
That gives it a span for every method call, but it only sees what is a Nest
provider: a Prisma query arrives as `PrismaService.user` with no SQL, and `pg`,
`ioredis`, `fetch` and `nodemailer` are invisible to it entirely.

Telescope instruments each library through its public API instead, so it already
holds the SQL with its bindings, the cache tier and hit/miss, the Redis command,
the outbound HTTP host and status. This package ships that detail into Observe's
UI as spans on the request that caused them.

It is also a way to feed Observe without adopting the `instrument` bootstrap
hook, which pins you to recent Nest 11 internals.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-observe
```

No runtime dependencies — gzip comes from `node:zlib` and the POST from global
`fetch`.

## Usage

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { ObserveExporter } from '@dudousxd/nestjs-telescope-observe';

const observe = new ObserveExporter({
  appKey: process.env.OBSERVE_APP_KEY!,
  appSecret: process.env.OBSERVE_APP_SECRET!,
  serviceId: 'orders-api',
  serviceVersion: process.env.GIT_SHA,
});

TelescopeModule.forRoot({
  storage,
  watchers: [...],
  extensions: [observe],
});
```

Call `await observe.close()` on shutdown to flush what is still buffered.

## What maps to what

| Telescope | Observe |
| --- | --- |
| a batch rooted at a `request` entry | one snapshot, `op` = `GET /orders/:id` |
| the batch's other entries | child spans, positioned by their offset into the request |
| `job` and `schedule` entries | job snapshots, with queue wait and attempts |
| `log` entries | forwarded logs, correlated to their trace |
| `exception` / `client_exception` | the error on the snapshot or on the span |
| process CPU, memory, GC, event loop | the `runtime` snapshot behind Observe's Profiler |
| every record, counted before sampling | `telescope.entries` and `telescope.duration_ms` custom metrics |

## Controlling the bill

Observe meters per ingested record — a request, job, error or log each count as
one event, a span as a quarter — so the defaults here are deliberately explicit
rather than "send everything and hope".

```ts
new ObserveExporter({
  // ...credentials,
  include: { requests: true, spans: true, jobs: true, logs: false, runtime: true, metrics: true },
  sampleRate: 0.2,
  filter: (entry) => entry.type !== 'cache',
});
```

- **`include`** turns whole sections off. `logs` needs a paid Observe plan. `runtime` and
  `metrics` describe the process rather than the traffic, so sampling does not apply to them.
- **`sampleRate`** is per batch, not per entry, so a sampled request keeps all of
  its spans instead of a random half. A batch containing a failure is always
  forwarded regardless of the rate.
- **`filter`** gets the last word on any single entry.

This is separate from Telescope's own `sampling` on purpose: what is worth
keeping locally for an hour is not the same question as what is worth paying to
retain for ninety days.

## Notes

- **The ingest API is private.** `POST /applications/telemetry` is undocumented,
  unversioned, and validated against a strict allowlist on their side, so a
  renamed field there becomes a `400` here. That failure is logged with its
  status; it is not retried, because retrying cannot fix it.
- **Wrong credentials trip a breaker.** Consecutive `401`/`403` responses disable
  the exporter and re-log on a decaying schedule, so a bad key is visible in the
  log instead of becoming a silent daily 401 storm.
- **Retries exist.** Network errors, `408`, `429` and `5xx` are retried with
  backoff — Observe's own SDK drops every batch it fails to deliver.
- **Nothing blocks the host.** The Telescope flush hook only buffers; encoding
  and the POST run on this exporter's own unref'd timer, and no error escapes
  into capture.
- **`runtime` is all-or-nothing.** Observe's collector answers `500` — not a validation `400` —
  to a `runtime` object missing any of CPU, memory, GC or event loop, an empty one included. A
  snapshot that could not measure all four is withheld and retried on the next flush rather than
  sent partially.
- **Counters are taken before sampling.** They come from Telescope's `observeRecord` hook, so
  `telescope.entries` reports what the process actually did, not what survived `sampleRate`.
- **User data stays out of span tags.** SQL bindings, cache values, request
  payloads and mail bodies are never put on the wire — this ships to a
  third-party SaaS.
- **It cannot be pointed somewhere private.** `endpoint` is configurable, but no
  open-source collector for this protocol exists, so there is no self-hosted
  destination to aim it at. For an environment where data may not leave the
  network, Telescope's own storage is the answer, not this package.

## License

MIT
