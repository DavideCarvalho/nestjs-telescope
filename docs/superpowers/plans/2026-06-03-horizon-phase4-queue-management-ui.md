# Horizon Phase 4 — Queue Management UI — Plan

> Sub-skill: superpowers:subagent-driven-development. Design contract: `docs/superpowers/specs/2026-06-03-horizon-queue-management-design.md`.

**Goal:** A Horizon-grade live **queue management** UI consuming the Phase 1/2 backend: browse queues with live counts → state tabs → job table with payload preview → job detail drawer → action buttons (retry/remove/promote, retry-all) that appear ONLY when the driver supports the action AND mutations are enabled. Polling for live state. Dark, polished.

**Packages:** small core glue (capabilities) in `packages/core`, then frontend in `packages/ui`. Follow existing conventions (Phase 3 charts, `createTelescopeClient` `get<T>`, options-returning hooks, HashRouter, dark palette).

## Task 1 — Core: capability info on the live response (so the UI knows what's allowed)
- In `packages/core/src/nest/telescope.controller.ts`, inject `TELESCOPE_OPTIONS` (read whether `authorizeAction` is configured) and change `GET queues/live` to return:
  ```ts
  { queues: QueueSummary[], capabilities: { mutationsEnabled: boolean, actionsByDriver: Record<string, QueueActionName[]> } }
  ```
  - `mutationsEnabled = Boolean(this.options.authorizeAction)`.
  - `actionsByDriver[driver]` = the actions that manager implements: map over `this.queueManagers.all()`, for each derive `QUEUE_ACTIONS.filter(a => typeof manager[methodName(a)] === 'function')` where `methodName`: `retry→retry, remove→remove, promote→promote, 'retry-all'→retryAll, redrive→redrive`. Use a small typed helper (no `any` — index via a typed lookup of known method names).
- Update the Phase-1 `queues-live` controller spec for the new response shape (the `{ queues }` assertion becomes `{ queues, capabilities }`; add a case: a fake manager implementing `retry` but not `redrive` → `actionsByDriver.bullmq` includes `'retry'`, excludes `'redrive'`; `mutationsEnabled` true when `authorizeAction` set, false otherwise).
- `cd packages/core && pnpm test && pnpm typecheck`. Commit `feat(core): expose queue action capabilities on /queues/live`.

## Task 2 — UI client + hooks for live queues
- `packages/ui/src/client/telescope-client.ts` (+ `types.ts`): add methods using the existing `get<T>` + a new `post<T>` helper:
  - `liveQueues(): Promise<{ queues: QueueSummary[]; capabilities: QueueCapabilities }>`
  - `queueCounts(driver, queue)`, `queueJobs(driver, queue, state, { cursor?, limit? })`, `queueJob(driver, queue, id)`
  - `queueJobAction(driver, queue, id, action)` → POST `.../jobs/:id/:action`
  - `queueAction(driver, queue, action, { state? })` → POST `.../actions/:action`
  Import the DTO types (`QueueSummary`, `QueueCounts`, `QueueJob`, `QueueJobDetail`, `JobPage`, `QueueState`, `QueueActionName`) from `@dudousxd/nestjs-telescope` (re-export via `types.ts` if the existing client types are local). Add a `QueueCapabilities` type.
- `packages/ui/src/react/use-telescope-queries.ts`: add options-returning hooks matching the existing pattern: `liveQueuesQuery()/useLiveQueues()`, `queueJobsQuery(driver,queue,state,page)/useQueueJobs(...)`, `queueJobQuery(...)/useQueueJob(...)`, with a polling `refetchInterval` (~2500ms) for counts/jobs. Add mutation hooks `useQueueJobAction()` / `useQueueAction()` (TanStack `useMutation`) that invalidate the affected queue's counts+jobs on success.
- Client spec: assert URLs/verbs for the new methods (mirror existing client spec). Commit `feat(ui): live-queue client methods + hooks`.

## Task 3 — UI components: queue list → tabs → job table → detail drawer → actions
- `src/react/components/queues/`:
  - `QueueList.tsx` — cards/rows per queue (driver + name + state-count badges, paused indicator). Click selects a queue.
  - `QueueStateTabs.tsx` — tabs waiting/active/delayed/failed/completed/paused with counts.
  - `JobTable.tsx` — rows: id, name, attempts, age/time, failedReason (truncated), payload preview (compact JSON). Click opens the drawer. Cursor "load more".
  - `JobDetailDrawer.tsx` — slide-over: full payload (pretty JSON, collapsible), opts, attempts, timestamps, stacktrace (for failed). Action buttons here + per-row.
  - `JobActions.tsx` — retry/remove/promote buttons, shown ONLY when `capabilities.actionsByDriver[driver]` includes the action AND `capabilities.mutationsEnabled`. `promote` only for delayed; `retry` for failed/completed; `remove` always (when supported). Confirm destructive (remove) via a small confirm. On 403 from the server, show a friendly "not authorized" toast/inline error (defense: server still enforces).
  - Failed tab → a "Retry all failed" button (when retry-all supported + enabled).
- Use the dark palette + Phase-3 chart cards if a small per-queue sparkline fits the header. Polling via the hooks.
- Component specs (render-without-crash + the gating logic: buttons HIDDEN when `mutationsEnabled` false or action unsupported; VISIBLE when both true). Commit `feat(ui): queue management components (list/tabs/table/drawer/actions)`.

## Task 4 — Page + routing + nav
- `src/app/pages/QueueManagerPage.tsx` composing the components (master-detail: queue list + selected queue's tabs/table; drawer overlay). Route `#/queues/manage` (or `#/horizon`); add a nav item ("Queues" management — distinct from the existing metrics "Queues" page, or merge: make the management page the primary Queues view with a metrics tab). Decide and keep nav coherent (don't ship two confusingly-named "Queues" items — fold metrics in as a sub-tab if cleaner).
- Spec: render the page with mocked client (queues + jobs + capabilities), assert the list + a tab + a job row render; assert actions hidden when `mutationsEnabled:false`. Commit `feat(ui): queue management page + routing`.

## Task 5 — Gate + changeset
- `cd packages/ui && pnpm test && pnpm typecheck && pnpm build && pnpm exec biome check src` green (vite build must succeed). Whole-repo `pnpm -w build`.
- `.changeset/horizon-queue-ui.md` minor `@dudousxd/nestjs-telescope` + `-ui`. Commit `docs(ui): changeset for queue management UI`.

## Acceptance
- The dashboard has a live queue management view: pick a queue → see live state tabs with counts → browse jobs with payloads → open a job's full detail → (when enabled) retry/remove/promote + retry-all, with server-side 403 handled gracefully.
- Buttons are correctly gated by capability + mutationsEnabled. vite build + whole repo + tests green.

## Notes
- Keep the live client methods typed off the core DTOs (single source of truth) — re-export from `@dudousxd/nestjs-telescope`.
- jsdom + Recharts caveat (Phase 3 `vitest.setup.ts` ResizeObserver stub already exists) applies if you add charts here.
- Do NOT implement SQS here (Phase 5). The UI should simply render whatever drivers `/queues/live` returns; a `bullmq` driver is the only one present now.
- mutationsEnabled is a UI HINT only — the server's default-deny `TelescopeActionGuard` is the real gate; the UI must still handle 403.
