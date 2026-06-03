# Horizon-style Queue Management + Dashboard — Design

**Status:** approved (brainstorm 2026-06-03). Decomposed into 5 phases; each gets its own implementation plan.

**Goal:** Bring `@dudousxd/nestjs-telescope` from read-only observability toward a Laravel Telescope/Horizon-grade console: a polished overview dashboard with rich charts, and full **live BullMQ queue management** (browse pending/active/delayed/failed/completed jobs with payloads; retry/delete/promote/retry-all actions), plus **SQS DLQ inspection + redrive**.

## Decisions (locked in brainstorm)

- **Drivers:** BullMQ gets full live management; SQS gets DLQ-only (inspect failed + redrive). SQS can't list pending messages — that's a protocol limit, not a scope cut.
- **Charts:** Recharts (pinned exact version), used ONLY in the `-ui` package. Accepted bundle cost (~100kb+) for rich dashboards fast.
- **Real-time:** polling (no SSE), consistent with the existing dashboard. Horizon also polls.
- **Process:** build directly in the real packages, iterate in code (no throwaway mockups).
- **Security:** queue mutations are a new, dangerous capability — gated SEPARATELY from reads and **default-deny**.

## Architecture — `QueueManager` SPI + registry (in core)

Core stays driver-agnostic. A new SPI is implemented by driver packages and registered like watchers; the controller exposes ONE unified API surface the UI consumes.

```
core: QueueManager SPI + queueManagers registry + /telescope/api/queues/live/* endpoints
  ├─ -bullmq:  BullMqQueueManager   (Redis Queue API: counts/jobs/job + retry/remove/promote/retryAll)
  └─ -sqs:     SqsQueueManager      (DLQ only: list failed + redrive)
```

**Why SPI+registry** (vs. endpoints inside `-bullmq`): one API surface for the UI, multi-driver, mirrors the existing `Watcher`/`StorageProvider` SPI pattern. Rejected: per-package controllers (fragments the API; SQS would re-fragment).

### SPI (core `src/queue/queue-manager.ts`)

```ts
export type QueueState = 'waiting' | 'active' | 'delayed' | 'failed' | 'completed' | 'paused';
export type QueueActionName = 'retry' | 'remove' | 'promote' | 'retry-all' | 'redrive';

export interface QueueCounts { waiting: number; active: number; delayed: number; failed: number; completed: number; paused: number; }
export interface QueueSummary { driver: string; queue: string; counts: QueueCounts; isPaused: boolean; }
export interface QueueJob {
  id: string; name: string; state: QueueState;
  attemptsMade: number; maxAttempts: number | null;
  timestamp: number | null; processedOn: number | null; finishedOn: number | null;
  failedReason: string | null; progress: number | null;
}
export interface QueueJobDetail extends QueueJob {
  data: unknown;            // payload (redacted via core redaction before leaving the server)
  opts: unknown;
  stacktrace: string[] | null;
  returnValue: unknown;
}
export interface JobPage { jobs: QueueJob[]; nextCursor: string | null; total: number | null; }

export interface QueueManager {
  readonly driver: string;                              // 'bullmq' | 'sqs'
  /** Resolve queue handles / connections. Called once at boot (like Watcher.register). */
  init(ctx: QueueManagerContext): void | Promise<void>;
  listQueues(): Promise<QueueSummary[]>;
  counts(queue: string): Promise<QueueCounts>;
  listJobs(queue: string, state: QueueState, page: { cursor?: string; limit?: number }): Promise<JobPage>;
  getJob(queue: string, id: string): Promise<QueueJobDetail | null>;
  // actions — optional per driver; presence advertises capability to the UI:
  retry?(queue: string, id: string): Promise<void>;
  remove?(queue: string, id: string): Promise<void>;
  promote?(queue: string, id: string): Promise<void>;       // delayed -> waiting
  retryAll?(queue: string, state: QueueState): Promise<number>;
  redrive?(queue: string): Promise<number>;                 // sqs DLQ -> source
}
```

- `QueueManagerContext` carries `moduleRef` + `redact` (so the manager redacts payloads server-side before they leave) — mirrors `WatcherContext`.
- Managers are passed via `TelescopeModule.forRoot({ queueManagers: [new BullMqQueueManager()] })`, registered into a `QUEUE_MANAGERS` token, and `init()`'d at `onApplicationBootstrap` (same lifecycle as watchers). A manager that finds no queues is inert (its driver simply contributes nothing).
- The UI discovers capabilities from the data: action buttons render only for actions the manager implements AND that the mutation gate allows.

### Endpoints (core `TelescopeController`)

Reads (under existing `authorizer`):
- `GET /telescope/api/queues/live` → `QueueSummary[]` across all managers.
- `GET /telescope/api/queues/live/:driver/:queue/counts`
- `GET /telescope/api/queues/live/:driver/:queue/jobs?state=&cursor=&limit=`
- `GET /telescope/api/queues/live/:driver/:queue/jobs/:id`

Mutations (under the NEW action gate — default 403):
- `POST /telescope/api/queues/live/:driver/:queue/jobs/:id/:action` (`retry|remove|promote`)
- `POST /telescope/api/queues/live/:driver/:queue/actions/retry-all?state=failed`
- `POST /telescope/api/queues/live/:driver/:queue/redrive`

Unknown driver/queue/state → 400/404. Action not implemented by the driver → 405. `:id` is validated; payloads redacted via core redaction on `getJob`.

## Security model

- **Reads:** existing `authorizer(ctx)` (default allow non-prod, deny prod).
- **Mutations:** new option `authorizeAction?(ctx: AuthorizerContext, action: { driver; queue; action: QueueActionName; jobId?: string }) => boolean | Promise<boolean>`. **Default returns false** → every mutation endpoint is 403 until the host opts in. Fails closed on throw (like the read guard). This keeps Telescope read-only-by-default; Horizon-style management is a conscious opt-in. A dedicated guard (`TelescopeActionGuard`) protects only the mutation routes.

## Phases (each = its own plan; built in order)

1. **Backend read** — `QueueManager` SPI + `QUEUE_MANAGERS` registry + lifecycle + read endpoints in core; `BullMqQueueManager` (discover queues via DiscoveryService/`getQueueToken`, implement `listQueues/counts/listJobs/getJob`). Everything depends on this.
2. **Backend actions** — mutation endpoints + `TelescopeActionGuard` + `authorizeAction` option (default-deny) + BullMQ `retry/remove/promote/retryAll`.
3. **Overview + charts** — Recharts into `-ui`; new Horizon-style Overview page (top stat cards, throughput-over-time area from `/timeseries`, per-type stacked area, recent failures/slowest); re-skin Pulse/Queues with Recharts.
4. **Queue management UI** — queue list with live counts → state tabs → job table with payload preview → job detail drawer (payload/opts/attempts/stacktrace) → action buttons (only when allowed) + retry-all on failed. Polling for live counts/jobs.
5. **SQS DLQ** — new `-sqs` package: `SqsQueueManager` (list DLQ/failed + `redrive`); its tab in the queue UI.

## Data flow

- Live counts/jobs: UI polls the `queues/live/*` read endpoints (~2–3s while a queue view is open).
- Time-series charts: reuse the existing `/telescope/api/timeseries` (computed from stored entries) — historical trend complements live counts.
- Actions: UI POSTs to mutation endpoints; on success, invalidate/refetch the affected queue's counts+jobs.

## Components & file structure (high level)

- core: `src/queue/queue-manager.ts` (SPI + types), `src/queue/queue-manager.registry.ts`, controller route additions, `src/nest/telescope-action.guard.ts`, `authorizeAction` in options.
- `-bullmq`: `src/bull-mq-queue-manager.ts` (+ queue discovery helper), tests (real Redis `skipIf(!REDIS_URL)` + structural mock).
- `-sqs` (new pkg, Phase 5): `src/sqs-queue-manager.ts` (DLQ + redrive), structural `SqsClientLike`.
- `-ui`: Recharts (pinned) in `src/react`; new client methods (`liveQueues`, `queueCounts`, `queueJobs`, `queueJob`, `queueAction`) in `src/client`; hooks in `src/react`; components: `OverviewPage`, chart components, `QueueManagerPage`, `QueueList`, `JobTable`, `JobDetailDrawer`, `JobActions`; routes/nav.

## Testing

- `BullMqQueueManager`: real-Redis integration `skipIf(!REDIS_URL)` (enqueue → list → counts → retry/remove) + a structural-mock unit test for CI (no Redis).
- Action gate: endpoint tests asserting **403 by default**, allowed when `authorizeAction` returns true, fail-closed on throw.
- Redaction: `getJob` payload runs through core redaction (secrets in job data never leave the server raw).
- Frontend: component specs in the existing pattern (render-without-crash, action buttons hidden when not allowed, job table renders payload preview).

## Out of scope (YAGNI, for now)

- SSE/websocket live tail (polling chosen).
- SQS pending-message browsing (protocol can't).
- Worker/supervisor scaling controls (Horizon's process management) — Telescope doesn't own workers.
- Per-queue pause/resume — could be a fast follow once actions land, not in v1.
