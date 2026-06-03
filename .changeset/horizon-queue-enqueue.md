---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-bullmq': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Let operators **enqueue (send) a new job/message** onto a queue from the dashboard.

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
