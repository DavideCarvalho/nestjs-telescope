# @dudousxd/nestjs-telescope-bullmq

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.1

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.0

## 1.2.1

## 1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [[`c2423f3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c2423f330be3f9b92c0dbf2348220bf8740dab86), [`d8173d4`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d8173d4c5d362814aa0fcdb0bfb35fd353b3d1a8), [`d200d15`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d200d158f927e6a67396e594b32bfd0a0b3424e4), [`953ae12`](https://github.com/DavideCarvalho/nestjs-telescope/commit/953ae12fd35e42df3b806d6bbec6b49e3e3c71fb), [`4ceb884`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4ceb8846b7307cf522d841c909d7eaf7fcb1aa4e), [`15e3e90`](https://github.com/DavideCarvalho/nestjs-telescope/commit/15e3e903d82616966342feeb966fbd44ad6a2631)]:
  - @dudousxd/nestjs-telescope@2.0.0

## 1.0.0

### Minor Changes

- [`73b50ad`](https://github.com/DavideCarvalho/nestjs-telescope/commit/73b50ad00193127271fdec36ad080d2858045922) - Add the BullMQ job watcher (`@dudousxd/nestjs-telescope-bullmq`). It discovers
  `@nestjs/bullmq` `WorkerHost` processors and wraps each job in a `'queue'` batch,
  capturing job outcome/duration/attempts and correlating the queries and
  exceptions a job emits to that job. Core now imports `DiscoveryModule` so
  discovery-based watchers can resolve `DiscoveryService`, and the canonical
  `JobContent` gains `id` and `maxAttempts`.

- [`a9f517c`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a9f517c076461aef55cfb90d072ec38427ace91b) - Add gated queue **mutation** endpoints on top of the live-queue reads. The core
  controller now exposes `POST /telescope/api/queues/live/:driver/:queue/jobs/:id/:action`
  (`retry` / `remove` / `promote`) and `POST .../actions/:action` (`retry-all`,
  `redrive`), each carrying `:action` so a single `TelescopeActionGuard` authorizes
  them uniformly.

  Mutations are **default-deny**: they run behind a new `authorizeAction` option
  _in addition to_ the read `authorizer`, and the guard fails closed. Without an
  `authorizeAction` callback every mutation returns `403` — even for callers the
  read authorizer already trusts. `authorizeAction(ctx, { driver, queue, action,
jobId?, state? })` opts in; returning falsy or throwing denies.

  `BullMqQueueManager` implements `retry` / `remove` / `promote` / `retryAll`
  against the real BullMQ `Job.retry()` / `Job.remove()` / `Job.promote()` and
  `Queue.retryJobs()` APIs (`retryAll` returns the pre-action count for the state).
  `redrive` remains SQS-only and returns `405` on the bullmq driver.

- [`9d8eb65`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9d8eb6562a7584801d5aa8b74491091f0fade5f9) - Let operators **enqueue (send) a new job/message** onto a queue from the dashboard.

  Core adds an optional `enqueue?(queue, payload, opts, ctx)` method to the
  `QueueManager` SPI and a new `POST /telescope/api/queues/live/:driver/:queue/enqueue`
  route. Unlike the other mutations it carries a JSON body (`{ name?, payload }`),
  so it lives on its own path rather than under `:action` — but it flows through the
  same default-deny `TelescopeActionGuard` as `retry` / `remove` / `redrive`: the
  guard recovers the `enqueue` action from the request path, so without an
  `authorizeAction` callback it returns `403`. The route returns `400` when the
  payload is absent and `404` when the driver is unknown or doesn't implement
  `enqueue`. `enqueue` is added to `QUEUE_ACTIONS` and advertised in the
  `/queues/live` `actionsByDriver` capabilities when a manager implements it.

  `BullMqQueueManager` implements `enqueue` via the real `Queue.add(name, data)`
  (defaulting the name to `manual`), returning the new job id.

  The UI gains an "Send message" form on the queue console — shown only when the
  selected driver advertises `enqueue` and mutations are enabled. It parses the
  payload textarea as JSON (invalid JSON surfaces inline without calling the API),
  posts via a new `queueEnqueue` client method, and on success confirms and
  refreshes the queue counts/jobs. A `403` surfaces inline as "Not authorized".

- [`418f1f0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/418f1f0421948b40b25f845441a716fa4c6655c2) - Add a driver-agnostic live-queue read layer. Core gains the `QueueManager` SPI
  (`QueueManager`, `QueueManagerContext`, `QueueManagerRegistry`) and its DTO types
  (`QueueState`, `QueueCounts`, `QueueSummary`, `QueueJob`, `QueueJobDetail`,
  `JobPage`), wired through a `queueManagers` option on `TelescopeModule.forRoot`
  and surfaced as read endpoints under the existing authorizer:
  `GET /telescope/api/queues/live`, `…/live/:driver/:queue/counts`,
  `…/live/:driver/:queue/jobs?state=`, and `…/live/:driver/:queue/jobs/:id`.

  `@dudousxd/nestjs-telescope-bullmq` adds `BullMqQueueManager`, which discovers
  `@nestjs/bullmq` `Queue` instances via `DiscoveryService` (duck-typed, optional
  explicit allow-list) and reads them through the BullMQ `Queue` API to report
  live counts, the jobs in each list, and per-job detail. Job payloads are passed
  through core redaction before leaving the server. Reads only this phase — queue
  actions (retry/remove/promote/redrive) land in Phase 2.

- [`de29d2f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/de29d2f519b1f25bc702c9dcc737d99b4751c8c9) - Add Horizon-style queue metrics. A new `GET /telescope/api/queues?window=1h`
  endpoint aggregates captured `job` entries into per-queue throughput, runtime
  and wait-time percentiles, and failure rate (`QueueMetricsService` +
  `aggregateQueueMetrics`). The BullMQ watcher now captures `waitMs`
  (`processedOn − enqueue`) on each job, and the canonical `JobContent` gains a
  `waitMs` field. `durationToMs` is extracted as a shared, exported util.

### Patch Changes

- Updated dependencies [[`73b50ad`](https://github.com/DavideCarvalho/nestjs-telescope/commit/73b50ad00193127271fdec36ad080d2858045922), [`9126bb0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9126bb04777cdaec6af3b0a1c5fe6f91d055ce82), [`1f00e62`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1f00e62c8e60482b64251813680a5f866ef1619a), [`090cd1f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/090cd1ff871dbe46c1c877a26f90496550b5304c), [`b7326b3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b7326b33d8d55b5f1ac5de4256f5e1980278699e), [`bfc0e26`](https://github.com/DavideCarvalho/nestjs-telescope/commit/bfc0e268388b5563d05c24e4de6ff99c74d1201a), [`7797a2a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7797a2a1554aff49bb59f5ca1b204974a7e04a41), [`6817fe6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6817fe62775b1ff847fdb1038d3298e7709569e0), [`20ceb87`](https://github.com/DavideCarvalho/nestjs-telescope/commit/20ceb878cd4495dfbc7a3c71d882ae216a633757), [`1dd4db0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1dd4db0f3cd46d04b35ac112343cfb424c2d3190), [`a9f517c`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a9f517c076461aef55cfb90d072ec38427ace91b), [`9d8eb65`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9d8eb6562a7584801d5aa8b74491091f0fade5f9), [`418f1f0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/418f1f0421948b40b25f845441a716fa4c6655c2), [`e76980d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e76980ddd7ee740f1b337a422a98ca98d97a007e), [`80c8f97`](https://github.com/DavideCarvalho/nestjs-telescope/commit/80c8f9769c8ab9ee724635086740910bc4d44ea3), [`e14ac60`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e14ac603551372fc3767c63a349c509582b5e6ab), [`6fa0946`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6fa0946f5543868704864af2e32793eb448ac827), [`d507547`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d507547df3c13e76e90b8a97c4e3e1d8aef25bd1), [`affd07e`](https://github.com/DavideCarvalho/nestjs-telescope/commit/affd07e4cb9ee85cfabaabed424833e8c638d04a), [`6a4d8d5`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6a4d8d56321d3840fe64e646130ccfdafcfb1bdd), [`c1f1ec9`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c1f1ec903d470d6b884924e2713de305b61b7481), [`cad6dae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/cad6dae0dba4f22e476d78c23ce2f74f7f6848e4), [`c8596c8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c8596c85712880cb235e8cce059a1d93d339e9bd), [`c4222b1`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c4222b16ef4c0fc9c61694eb67033f03369ff24e), [`de29d2f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/de29d2f519b1f25bc702c9dcc737d99b4751c8c9), [`10a3bc2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/10a3bc224f6e0b1a237e1e7631acad70493b4c12), [`abde392`](https://github.com/DavideCarvalho/nestjs-telescope/commit/abde39264effb31b0524cc4fa89a335276c8dccb), [`8ff32a2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8ff32a2cc95775224eea3377460d91674dfda47f), [`5f2eddd`](https://github.com/DavideCarvalho/nestjs-telescope/commit/5f2eddd0ed5d72bf1de323b45870d7ddcaf64349), [`b14a201`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b14a20175eae3d3017e8cbc068d367a03f634175), [`a90ef56`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a90ef569ba12484bece07d8de2045e13ff2ff528), [`593bcc8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/593bcc85ad6558040c62ba66bd1e5e0cbe5a6ac7), [`7b6636b`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7b6636b54438427cd53ea0cbedd186b77d807169), [`e64f35a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e64f35a1bb7cae15b2ef24404888463d04f81eef), [`4892ef6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4892ef61e45e5486d34c7ec82764e6767fe8233d)]:
  - @dudousxd/nestjs-telescope@1.0.0
