# Horizon Phase 5 — SQS DLQ Manager — Plan

> Sub-skill: superpowers:subagent-driven-development. Design contract: `docs/superpowers/specs/2026-06-03-horizon-queue-management-design.md`.

**Goal:** A new `@dudousxd/nestjs-telescope-sqs` package implementing the `QueueManager` SPI for SQS — DLQ-only (SQS can't browse pending messages): report counts, snapshot DLQ (failed) messages with payloads, and **redrive** the DLQ back to the source. Plus a small UI "Redrive DLQ" affordance gated by capability. This closes the Horizon milestone.

**Why limited:** SQS has no "list all messages" — you can only `ReceiveMessage` (which temporarily hides them) and read queue-depth approximations. So: `listJobs` only meaningful for `failed` (a best-effort DLQ snapshot via ReceiveMessage, messages reappear after the visibility timeout — we never delete); `retry/remove/promote` are NOT supported; the one action is `redrive` (AWS-native `StartMessageMoveTask`).

**Package:** new `packages/sqs` (mirror an existing adapter package's scaffold: `package.json`, `tsconfig.json`, `src/index.ts`, vitest). Peer-dep-free on the AWS SDK — duck-type the client (`SqsClientLike`) so the host passes their own `@aws-sdk/client-sqs` `SQSClient`.

## Task 1 — Scaffold `packages/sqs`
- Copy the scaffold shape of `packages/bullmq` (package.json name `@dudousxd/nestjs-telescope-sqs`, type module, exports `./dist/index.js`, peerDeps on `@dudousxd/nestjs-telescope` workspace:* + `@nestjs/common`/`core`; NO `@aws-sdk/*` runtime dep; add `@aws-sdk/client-sqs` to devDeps for test types only, pinned exact). tsconfig, vitest config, README stub, `src/index.ts`.
- Add to the pnpm workspace if needed (it globs `packages/*` — verify) and `pnpm install`.
- Commit `chore(sqs): scaffold @dudousxd/nestjs-telescope-sqs package`.

## Task 2 — `SqsQueueManager`
- `src/sqs-client.ts`: structural `SqsClientLike { send(command: unknown): Promise<unknown> }` + small typed command builders are NOT needed — instead accept command instances from the host OR (cleaner) the manager imports the command CLASSES lazily... NO. Keep it dependency-free: the manager accepts a `SqsClientLike` and builds commands as plain objects is not possible (SDK v3 needs Command instances). DECISION: the host passes BOTH the `SQSClient` and the SDK's command constructors via config, OR the manager takes a thin `SqsOps` port the host implements. SIMPLEST robust port:
  ```ts
  export interface SqsOps {
    approximateCounts(queueUrl: string): Promise<{ visible: number; notVisible: number }>;
    receiveDlq(dlqUrl: string, max: number): Promise<Array<{ id: string; body: string; attributes?: Record<string, string> }>>;
    redrive(dlqArn: string, sourceArn: string): Promise<void>;
    queueArn(queueUrl: string): Promise<string>;
  }
  ```
  Provide a default `createAwsSqsOps(client: SQSClient)` factory in `src/aws-sqs-ops.ts` that implements `SqsOps` using `@aws-sdk/client-sqs` commands (`GetQueueAttributesCommand`, `ReceiveMessageCommand`, `StartMessageMoveTaskCommand`) — this file is the ONLY one importing the SDK, and it's tree-shake/optional (host can supply their own `SqsOps`). The manager depends only on the `SqsOps` port → fully testable with a mock, no AWS in CI.
- `src/sqs-queue-manager.ts`: `class SqsQueueManager implements QueueManager` (driver `'sqs'`). Config: `new SqsQueueManager({ ops: SqsOps, queues: Array<{ name: string; url: string; dlqUrl: string }> })`. `init(ctx)` stores `ctx.redact`.
  - `listQueues()`: per configured queue, `ops.approximateCounts(url)` (→ waiting=visible, active=notVisible) + `approximateCounts(dlqUrl)` (→ failed=visible). counts.{delayed,completed,paused}=0. isPaused=false.
  - `counts(name)`: same for one.
  - `listJobs(name, state, page)`: if `state !== 'failed'` → `{ jobs: [], nextCursor: null, total: null }`. For `failed`: `ops.receiveDlq(dlqUrl, limit≤10)` → map each to `QueueJob` (id=message id, name=queue name, state='failed', attemptsMade from ApproximateReceiveCount attribute if present, others null/0). CACHE the full received messages (id → { body, attributes }) in a short-lived in-memory Map so `getJob` can return the body (received messages aren't refetchable by id). nextCursor null (no real pagination).
  - `getJob(name, id)`: return the cached received message as `QueueJobDetail` (data = `ctx.redact(JSON.parse(body) or body)`, opts/stacktrace/returnValue null). null if not in cache.
  - `redrive(name)`: resolve `dlqArn = ops.queueArn(dlqUrl)`, `sourceArn = ops.queueArn(url)`, `ops.redrive(dlqArn, sourceArn)`. Return the pre-redrive failed count (best-effort).
  - Do NOT implement `retry/remove/promote/retryAll`.
- Redact DLQ bodies via `ctx.redact` before they leave (security — same as BullMQ).
- Export `SqsQueueManager`, `SqsOps`, `createAwsSqsOps` from `src/index.ts`.
- Tests (mock `SqsOps`, CI-safe — NO AWS): listQueues maps visible/notVisible/dlq→counts; listJobs('failed') maps + redacts body + caches; listJobs('waiting') empty; getJob returns cached redacted detail (null when absent); redrive calls `ops.redrive(dlqArn, sourceArn)` and returns pre-count. A separate `aws-sqs-ops.spec.ts` may mock `SQSClient.send` to assert the right command shapes (optional, light).
- Commit `feat(sqs): add SqsQueueManager (DLQ snapshot + redrive)`.

## Task 3 — README + changeset
- `packages/sqs/README.md`: wiring (`queueManagers: [new SqsQueueManager({ ops: createAwsSqsOps(new SQSClient(...)), queues: [{name,url,dlqUrl}] })]`), the DLQ-only limitations (no pending browse, snapshot semantics, redrive is the action), and that `redrive` is gated by `authorizeAction` (default-deny).
- `.changeset/horizon-sqs.md`: minor for `@dudousxd/nestjs-telescope-sqs` (new) — changesets handles first publish.
- Commit `docs(sqs): document SqsQueueManager + changeset`.

## Task 4 — UI: Redrive affordance
- In `packages/ui`, add a "Redrive DLQ" button to the queue management UI (on the failed tab / queue header in `QueueManagerPage` or `JobActions`), shown ONLY when `capabilities.actionsByDriver[driver]` includes `'redrive'` AND `capabilities.mutationsEnabled`. Uses the existing `useQueueAction()` with `action:'redrive'`. Confirm before firing (it moves messages). 403 → inline "Not authorized".
- The rest of the management UI already renders any driver generically (an `'sqs'` queue shows up in `QueueList` with its failed count; non-failed tabs are empty, which is correct for SQS).
- Spec: button hidden when `'redrive'` not in capabilities; visible + calls the mutation when present.
- Commit `feat(ui): redrive DLQ action for SQS-style drivers`.

## Task 5 — Gate
- `pnpm install` (new package), then `cd packages/sqs && pnpm test && pnpm typecheck && pnpm build`, `cd packages/ui && pnpm test && pnpm typecheck && pnpm build`, whole-repo `pnpm -w build && pnpm -w test && pnpm -w lint` ALL green (now 12 packages). Commit any fixups.

## Acceptance
- New `-sqs` package builds + tests green (no AWS in CI). An `sqs` driver surfaces in the live-queue UI with DLQ counts; the failed tab shows redacted DLQ message snapshots; a gated "Redrive DLQ" button triggers `StartMessageMoveTask`. Whole repo (12 pkgs) green. Milestone Horizon complete.

## Notes
- The `SqsOps` port is the key design move: it keeps the SDK import in ONE optional file, makes the manager 100% unit-testable without AWS, and lets advanced hosts supply a custom impl. Don't take a hard `@aws-sdk/client-sqs` runtime dep.
- `StartMessageMoveTask` requires the DLQ to have been a redrive target; document that. Manual receive→send→delete is the fallback if a host's DLQ isn't configured for native redrive — NOTE it in the README but implement the native command as the default.
- No real-AWS integration test (unlike BullMQ's real-Redis) — SQS has no free local analog in this repo; the mock-`SqsOps` unit tests are the contract. Say so in the README.
