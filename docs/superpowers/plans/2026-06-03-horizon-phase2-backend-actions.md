# Horizon Phase 2 — Backend Queue Actions + Authz — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Add mutation endpoints (retry/remove/promote a job, retry-all, redrive) gated by a NEW default-deny `authorizeAction` option via `TelescopeActionGuard`, and implement `retry/remove/promote/retryAll` on `BullMqQueueManager`. Reads from Phase 1 stay under the existing `authorizer`; mutations require BOTH the read guard AND action authorization.

**Architecture:** All mutation routes carry `:action` in their params so one guard reads `request.params` uniformly. `TelescopeActionGuard` returns false (403) unless `options.authorizeAction(ctx, { driver, queue, action, jobId })` returns true; it fails closed on throw (mirrors `TelescopeGuard`). Mutation routes live on `TelescopeController` (already class-guarded by `TelescopeGuard`) with an additional method-level `@UseGuards(TelescopeActionGuard)`.

**Tech Stack:** NestJS 11 guards/Reflector, `bullmq@5.78.0` (`Job.retry/remove/promote`, `Queue.retryJobs`), vitest, real-Redis `skipIf`.

Spec: `docs/superpowers/specs/2026-06-03-horizon-queue-management-design.md` (security model section). Builds on Phase 1 (committed): `QueueManager` SPI with optional `retry?/remove?/promote?/retryAll?/redrive?`, `BullMqQueueManager`, `/queues/live/*` reads.

---

## File Structure
- Modify `packages/core/src/queue/queue-manager.ts` — add `QueueActionName`, `QueueActionRequest`.
- Modify `packages/core/src/nest/telescope.options.ts` — add `authorizeAction?`.
- Create `packages/core/src/nest/telescope-action.guard.ts` — `TelescopeActionGuard`.
- Modify `packages/core/src/nest/telescope.module.ts` — register `TelescopeActionGuard`.
- Modify `packages/core/src/nest/telescope.controller.ts` — mutation routes.
- Modify `packages/bullmq/src/queue-discovery.ts` — extend `QueueLike` (job ops + `retryJobs`).
- Modify `packages/bullmq/src/bull-mq-queue-manager.ts` — implement actions.
- Tests + changeset + README.

---

## Task 1: Core action types + `authorizeAction` option

**Files:** Modify `queue-manager.ts`, `telescope.options.ts`.

- [ ] **Step 1: action types** — append to `packages/core/src/queue/queue-manager.ts`:
```ts
export type QueueActionName = 'retry' | 'remove' | 'promote' | 'retry-all' | 'redrive';

export const QUEUE_ACTIONS: readonly QueueActionName[] = ['retry', 'remove', 'promote', 'retry-all', 'redrive'];

export function isQueueAction(value: unknown): value is QueueActionName {
  return typeof value === 'string' && (QUEUE_ACTIONS as readonly string[]).includes(value);
}

/** What the action authorizer is told about a requested mutation. */
export interface QueueActionRequest {
  driver: string;
  queue: string;
  action: QueueActionName;
  jobId?: string;
  state?: QueueState; // for retry-all
}
```

- [ ] **Step 2: option** — in `telescope.options.ts`, import `QueueActionRequest` from `../queue/queue-manager.js`, add to `TelescopeModuleOptions`:
```ts
  /**
   * Authorizes a queue MUTATION (retry/remove/promote/retry-all/redrive).
   * Separate from `authorizer` (reads). DEFAULT: deny — every mutation is 403
   * until the host supplies this. Throwing denies (fails closed).
   */
  authorizeAction?: (
    ctx: AuthorizerContext,
    action: QueueActionRequest,
  ) => boolean | Promise<boolean>;
```

- [ ] **Step 3: typecheck** — `cd packages/core && pnpm typecheck`. Commit `feat(core): add queue action types + authorizeAction option (default-deny)`.

---

## Task 2: `TelescopeActionGuard`

**Files:** Create `packages/core/src/nest/telescope-action.guard.ts`; Modify `telescope.module.ts`, core index; Test: `telescope-action.guard.spec.ts`.

- [ ] **Step 1: guard** (exact content)
```ts
// packages/core/src/nest/telescope-action.guard.ts
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { isQueueAction, isQueueState, type QueueActionRequest } from '../queue/queue-manager.js';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';

interface MutationParams { driver?: string; queue?: string; action?: string; id?: string; }
interface MutationQuery { state?: string; }

@Injectable()
export class TelescopeActionGuard implements CanActivate {
  constructor(@Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Default-deny: no authorizeAction means mutations are forbidden.
    if (!this.options.authorizeAction) return false;
    const request = context.switchToHttp().getRequest<{ params?: MutationParams; query?: MutationQuery }>();
    const params = request.params ?? {};
    const query = request.query ?? {};
    if (!params.driver || !params.queue || !isQueueAction(params.action)) return false;
    const action: QueueActionRequest = {
      driver: params.driver,
      queue: params.queue,
      action: params.action,
      ...(params.id !== undefined ? { jobId: params.id } : {}),
      ...(isQueueState(query.state) ? { state: query.state } : {}),
    };
    try {
      return await this.options.authorizeAction({ request }, action);
    } catch {
      return false; // fail closed
    }
  }
}
```

- [ ] **Step 2: register + export** — add `TelescopeActionGuard` to `SHARED_PROVIDERS` in `telescope.module.ts`; `export * from './nest/telescope-action.guard.js';` in core index (if guards are exported — check existing index for `telescope.guard.js`; match it).

- [ ] **Step 3: test** — `telescope-action.guard.spec.ts`: construct the guard with a fake `ExecutionContext` whose request has `params={driver:'bullmq',queue:'q1',action:'retry',id:'5'}`. Assert:
  - No `authorizeAction` → `false`.
  - `authorizeAction: () => true` → `true`, and it was called with `({request}, {driver:'bullmq',queue:'q1',action:'retry',jobId:'5'})`.
  - `authorizeAction: () => false` → `false`.
  - `authorizeAction: () => { throw new Error('x') }` → `false` (fail closed).
  - Invalid action param (`action:'bogus'`) → `false` without calling authorizeAction.
  - retry-all with `query.state='failed'` → action includes `state:'failed'`.
  (Build a minimal fake `ExecutionContext`: `{ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext` — test-double, mirrors existing guard specs.)
- [ ] **Step 4: run + commit** — `pnpm test telescope-action.guard && pnpm typecheck`. Commit `feat(core): add TelescopeActionGuard (default-deny mutation gate)`.

---

## Task 3: Core mutation endpoints

**Files:** Modify `telescope.controller.ts`; Test: extend `telescope.controller.queues-live.spec.ts` (or new `...actions.spec.ts`).

- [ ] **Step 1: routes** — add to `TelescopeController` (import `Post`, `UseGuards`, `TelescopeActionGuard`, `isQueueState`, `isQueueAction`, action types, `MethodNotAllowedException`):
```ts
  @Post('queues/live/:driver/:queue/jobs/:id/:action')
  @UseGuards(TelescopeActionGuard)
  async jobAction(
    @Param('driver') driver: string,
    @Param('queue') queue: string,
    @Param('id') id: string,
    @Param('action') action: string,
  ): Promise<{ ok: true }> {
    const manager = this.requireManager(driver);
    if (action === 'retry') { await this.callAction(manager.retry, manager, queue, id, action); }
    else if (action === 'remove') { await this.callAction(manager.remove, manager, queue, id, action); }
    else if (action === 'promote') { await this.callAction(manager.promote, manager, queue, id, action); }
    else throw new BadRequestException(`Invalid job action: ${action}`);
    return { ok: true };
  }

  @Post('queues/live/:driver/:queue/actions/:action')
  @UseGuards(TelescopeActionGuard)
  async queueAction(
    @Param('driver') driver: string,
    @Param('queue') queue: string,
    @Param('action') action: string,
    @Query('state') state?: string,
  ): Promise<{ ok: true; count?: number }> {
    const manager = this.requireManager(driver);
    if (action === 'retry-all') {
      if (!isQueueState(state)) throw new BadRequestException(`Invalid state: ${state}`);
      if (!manager.retryAll) throw new MethodNotAllowedException(`Driver ${driver} cannot retry-all`);
      return { ok: true, count: await manager.retryAll(queue, state) };
    }
    if (action === 'redrive') {
      if (!manager.redrive) throw new MethodNotAllowedException(`Driver ${driver} cannot redrive`);
      return { ok: true, count: await manager.redrive(queue) };
    }
    throw new BadRequestException(`Invalid queue action: ${action}`);
  }

  private async callAction(
    fn: ((queue: string, id: string) => Promise<void>) | undefined,
    manager: QueueManager, queue: string, id: string, action: string,
  ): Promise<void> {
    if (!fn) throw new MethodNotAllowedException(`Driver ${manager.driver} cannot ${action}`);
    await fn.call(manager, queue, id);
  }
```
NOTE: the `:action` segment placement means the mutation routes are POST and won't collide with the GET `jobs/:id` read. Confirm route registration order keeps `actions/:action` and `jobs/:id/:action` unambiguous (different verb + path depth — fine).

- [ ] **Step 2: test** — endpoint spec: app with `queueManagers:[fakeManager]` where fake implements `retry/remove/promote/retryAll` (record calls) and OMITS `redrive`. With `authorizeAction: () => true`:
  - `POST .../bullmq/q1/jobs/5/retry` → 200 `{ok:true}`, fake.retry called with ('q1','5').
  - `POST .../bullmq/q1/jobs/5/bogus` → 400.
  - `POST .../bullmq/q1/actions/retry-all?state=failed` → 200 `{ok:true,count:N}`.
  - `POST .../bullmq/q1/actions/redrive` → 405 (fake omits redrive).
  - With NO `authorizeAction` (separate app): `POST .../bullmq/q1/jobs/5/retry` → 403.
  - With `authorizeAction: () => false`: → 403.
- [ ] **Step 3: run + commit** — `pnpm test && pnpm typecheck && pnpm build`. Commit `feat(core): add gated queue mutation endpoints`.

---

## Task 4: `BullMqQueueManager` actions

**Files:** Modify `queue-discovery.ts`, `bull-mq-queue-manager.ts`; extend tests.

- [ ] **Step 1: extend `QueueLike`** — in `queue-discovery.ts` add to the interface (and keep `isQueueLike` checking only the READ methods so discovery is unchanged):
```ts
  // actions (present on real bullmq Queue; optional in the structural type):
  retryJobs?(opts: { state?: string; count?: number }): Promise<void>;
```
And a job-ops structural type + guard:
```ts
export interface JobOps { retry(state?: string): Promise<void>; remove(): Promise<void>; promote(): Promise<void>; }
export function hasJobOps(value: unknown): value is JobOps {
  if (typeof value !== 'object' || value === null) return false;
  const j = value as Record<string, unknown>;
  return typeof j.retry === 'function' && typeof j.remove === 'function' && typeof j.promote === 'function';
}
```

- [ ] **Step 2: implement actions** — in `bull-mq-queue-manager.ts`:
```ts
  async retry(queue: string, id: string): Promise<void> {
    const job = await this.require(queue).getJob(id);
    if (!hasJobOps(job)) throw new Error(`Job ${id} not found in ${queue}`);
    await job.retry();
  }
  async remove(queue: string, id: string): Promise<void> {
    const job = await this.require(queue).getJob(id);
    if (!hasJobOps(job)) throw new Error(`Job ${id} not found in ${queue}`);
    await job.remove();
  }
  async promote(queue: string, id: string): Promise<void> {
    const job = await this.require(queue).getJob(id);
    if (!hasJobOps(job)) throw new Error(`Job ${id} not found in ${queue}`);
    await job.promote();
  }
  async retryAll(queue: string, state: QueueState): Promise<number> {
    const q = this.require(queue);
    const before = (await this.countsFor(q))[state] ?? 0;
    if (typeof q.retryJobs === 'function') await q.retryJobs({ state: STATE_TO_BULL[state] });
    return before;
  }
```
(import `hasJobOps`. No `redrive` — that's SQS, Phase 5.)

- [ ] **Step 3: VERIFY bullmq API** — confirm against `bullmq@5.78.0` (node_modules types or context7 `/taskforcesh/bullmq`): `Job.retry(state?)`, `Job.remove()`, `Job.promote()`, `Queue.retryJobs({ state, count })`. `Job.retry()` defaults to retrying a FAILED job; for completed→ `retry('completed')`. `retryJobs` bulk-retries by state. Adjust if the installed signatures differ; report findings.

- [ ] **Step 4: tests** — unit (mock): a `QueueLike` whose `getJob` returns a stub with `retry/remove/promote` spies + a `retryJobs` spy; assert `manager.retry/remove/promote` call them; `retryAll('q','failed')` calls `retryJobs({state:'failed'})` and returns the pre-count; unknown/absent job throws. Integration (real Redis, skipIf): enqueue a job that FAILS (throw in processor), wait until it's in `failed`, `manager.retry('telescope-test','<id>')`, assert it leaves `failed` (counts.failed drops or job re-runs); `manager.remove` a job and assert counts drop.
- [ ] **Step 5: run + commit** — `cd packages/bullmq && pnpm test && pnpm typecheck && pnpm build && pnpm exec biome check src`. Commit `feat(bullmq): implement queue actions (retry/remove/promote/retryAll)`.

---

## Task 5: Gate + docs
- [ ] **Step 1** — whole-repo `pnpm -w build && pnpm -w test && pnpm -w lint` green. Run the bullmq action integration vs local Redis (build `REDIS_URL` from flip `.env`, grep not source) to validate for real.
- [ ] **Step 2: changeset** — `.changeset/horizon-queue-actions.md`: minor `@dudousxd/nestjs-telescope` + `-bullmq`, summarizing gated mutation endpoints + `authorizeAction` default-deny + BullMQ actions.
- [ ] **Step 3: README** — `packages/bullmq/README.md`: document the mutation endpoints + how to enable them (`authorizeAction`), stressing default-deny. Commit `docs(bullmq): document queue actions + authorizeAction`.

## Notes for executor
- `authorizeAction` default-deny is a SECURITY property — the 403-by-default endpoint test is the guard's correctness proof; do not weaken it.
- Method-level `@UseGuards(TelescopeActionGuard)` runs IN ADDITION to the class-level `TelescopeGuard` (read auth) — mutations require both. Keep it.
- No SQS in this phase. `redrive` stays unimplemented on BullMqQueueManager (the 405 path covers it).
```
