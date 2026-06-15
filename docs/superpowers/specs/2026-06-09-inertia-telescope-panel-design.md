# Design Spec — Inertia Debug Panel for nestjs-telescope

**Date:** 2026-06-09
**Status:** Proposed (implementation-ready)
**Spans:** `nestjs-inertia` (producer) ↔ `nestjs-telescope` (consumer)

## 0. Goal & constraints

Make every Inertia response observable in the Telescope dashboard: rendered
component, fully-resolved props (after markers run), deferred props + groups,
optional/once/merge classification, the partial-reload decision (kept/excluded
keys), asset version + 409 version-mismatch, history-encryption flags, shared
props applied, and final page size.

**Hard constraint:** the libs stay decoupled. `nestjs-inertia` MUST NOT depend on
`nestjs-telescope`. The bridge is Node's `node:diagnostics_channel`: inertia
*publishes*; telescope *subscribes*. When nobody subscribes, `channel.hasSubscribers`
is `false` and we never build the payload — cost ≈ zero.

This is a **net-new integration pattern for both repos.** A grep confirms neither
side currently uses `diagnostics_channel`:
- inertia: no occurrences under `packages/core/src`.
- telescope: every watcher today wraps a provider (EventEmitter2 `onAny`, ioredis
  `sendCommand` monkey-patch, Nest `Logger`). There is no DC subscriber yet — this
  watcher introduces the first one, but it reuses the existing `Watcher` interface
  and `WatcherContext.record(...)` machinery unchanged.

---

## 1. Event contract (the wire between the libs)

### 1.1 One event per response — recommended

Emit **one** event per Inertia response, after all markers/partial filtering are
resolved but before the response is written. Rationale:

- Telescope's storage model is **one entry per logical occurrence** (`RecordInput`
  → one `Entry`), correlated into a request batch (see `entry.ts`). One Inertia
  event → one `inertia` entry maps perfectly. Granular events (per-prop, per-marker)
  would explode entry counts and break the batch-timeline UX.
- All the data the developer wants (component, resolved props, deferred groups,
  partial decision, version, flags, size) is known at a *single* point in
  `InertiaService.render()` — line ~448 where the `PageObject` is assembled. No need
  to stitch multiple events.
- Keeps the producer change to a single `publish()` call.

### 1.2 Channel name

```
nestjs-inertia:render
```

Versioned-by-shape, not by name. A `v` field inside the payload lets the watcher
reject/upgrade older producers. Exported as a constant from inertia
(`export const INERTIA_DIAG_CHANNEL = 'nestjs-inertia:render'`) AND hardcoded in
the telescope watcher (telescope must not import inertia). The string is the
contract.

### 1.3 Payload shape

The payload carries enough to render the panel WITHOUT re-deriving inertia
internals. Produced lazily (§2). Sensitive heavy field is `resolvedProps`.

```ts
// Conceptual shape (lives in NEITHER package as a shared import; duplicated as a
// structural type on both sides — telescope validates defensively).
interface InertiaRenderDiagnostic {
  v: 1;                              // payload schema version
  component: string;                 // page.component
  url: string;                       // page.url (req.originalUrl)
  method: string;                    // req.method
  // --- request classification ---
  isInertia: boolean;                // had X-Inertia header (XHR) vs full doc load
  isPartial: boolean;                // X-Inertia-Partial-Component === component
  partial: {
    only: string[];                  // X-Inertia-Partial-Data (kept)   — [] when none
    except: string[];                // X-Inertia-Partial-Except (excluded)
    reset: string[];                 // X-Inertia-Reset
    resetOnce: string[];             // X-Inertia-Reset-Once
  };
  // --- prop classification (keys only, cheap) ---
  props: {
    sharedKeys: string[];            // keys contributed by share() (module+feature+inline)
    finalKeys: string[];             // keys present in the wire page.props
    deferred: Record<string, string[]>; // page.deferredProps: group -> [dotPaths]
    merge: string[];                 // page.mergeProps
    deepMerge: string[];             // page.deepMergeProps
    matchPropsOn: Record<string, string>; // page.matchPropsOn
    // marker classification, derived during render (NEW bookkeeping, see §3.2):
    optionalKeys: string[];          // keys that were optional() (resolved or omitted)
    onceKeys: string[];              // keys that were once()
    excludedKeys: string[];          // keys dropped by partial/except this response
  };
  // --- the heavy payload (lazy + bounded, see §2) ---
  resolvedProps: unknown;            // the FINAL wire props object (page.props)
  // --- versioning / history ---
  assetVersion: string;              // deps.assetVersion / page.version
  versionMismatch: boolean;          // true when the 409 short-circuit fired
  clientVersion: string | null;      // X-Inertia-Version sent by client
  encryptHistory: boolean;           // page.encryptHistory
  clearHistory: boolean;             // page.clearHistory
  // --- response shape ---
  statusCode: number;                // 200 | 409
  pageBytes: number;                 // byte length of JSON.stringify(page)
  ssr: boolean;                      // SSR module produced output this render
  // --- correlation (see §6) ---
  // (no field needed: the subscriber runs in the SAME async context as render(),
  //  so Telescope's ALS batch correlation already binds the entry to the request.)
}
```

### 1.4 The version-mismatch case

The 409 short-circuit (`service.ts:294-303`) returns BEFORE the page is built, so
it has no props. Emit a *minimal* variant of the same event at that branch:
`{ component, url, method, isInertia:true, versionMismatch:true, statusCode:409,
clientVersion, assetVersion, ...empty arrays }`. Same channel, same shape, heavy
fields absent. This makes "why did my page reload?" debuggable — the single most
confusing Inertia behavior.

---

## 2. Zero-cost-when-off + bounded capture

### 2.1 The `hasSubscribers` gate

```ts
// in service.ts, module-scope singleton:
import diagnostics_channel from 'node:diagnostics_channel';
const inertiaChannel = diagnostics_channel.channel(INERTIA_DIAG_CHANNEL);

// at the publish point:
if (inertiaChannel.hasSubscribers) {
  inertiaChannel.publish(buildDiagnostic(/* refs to local vars */));
}
```

`channel()` is memoized by Node (same object per name). `hasSubscribers` is a
boolean field flipped by `subscribe()`/`unsubscribe()` — reading it is free. When
Telescope's watcher is not installed, `buildDiagnostic()` is never called, so we
never clone props, never `JSON.stringify` the page for `pageBytes`, never allocate
the arrays. **This is the whole decoupling story: a `false` boolean check per
render in production.**

### 2.2 Cost of capturing resolved props

`resolvedProps` is the page's full prop tree and can be large (a paginated list, a
hydrated user graph). Two layers protect us:

1. **Producer-side cheap path.** inertia does NOT deep-clone or stringify props.
   It passes the *existing* `wireProps` object reference into the event. No copy.
   The expensive `pageBytes` is computed from the `JSON.stringify(page)` that the
   `.json(page)` path already needs anyway for Inertia XHR responses — reuse it; do
   NOT stringify twice. (For full-document SSR loads where the JSON isn't otherwise
   serialized, compute `pageBytes` only inside the `hasSubscribers` guard.)

2. **Consumer-side bounding — reuse Telescope's existing redaction budget.** The
   Recorder already runs `redactBounded()` on every entry's `content`
   (`recorder.ts`, `redaction/redact.ts`), which is exactly the detach + clip step:
   - `DEFAULT_MAX_DEPTH = 8`
   - `DEFAULT_MAX_STRING_LENGTH = 8_192`
   - `DEFAULT_MAX_ARRAY_LENGTH = 200`
   - `DEFAULT_MAX_NODES = 5_000`
   - `DEFAULT_MAX_CONTENT_BYTES = 16_384`
   - secret keys masked via `DEFAULT_REDACT_KEYS` (`password`, `token`,
     `authorization`, `secret`, `api_key`, …)

   So the watcher does **nothing special** for size/redaction: it hands
   `resolvedProps` into `content` and the Recorder clips + masks it, incrementing
   `truncatedCount` when bounds bite. This is the same protection `req.user` mega-
   graphs already get (see the redact.ts doc comment referencing the GC-spiral
   incident). The producer must NOT pre-stringify resolvedProps, or the Recorder
   can't traverse/redact it.

3. **Sampling** comes for free: Telescope supports per-type `sampling` rules
   (config `sampling`, `SamplingRule`). Hosts can tail-sample `inertia` entries
   (e.g. keep 10%) with no producer change.

### 2.3 No work on the hot path when subscribed-but-bounded

The only producer cost when subscribed is: building ~8 small arrays of *keys*
(already iterated in the render loop) + passing two object references. The marker
classification arrays (`optionalKeys`, `onceKeys`, `excludedKeys`) are populated as
a side-effect of the loop inertia already runs (§3.2), guarded so they're only
pushed-to when `hasSubscribers` — see §3.

---

## 3. nestjs-inertia changes (producer)

### 3.1 No new dependency

`node:diagnostics_channel` is a core module — adds nothing to `package.json`. The
inertia `peerDependencies` block (`@nestjs/common`, `rxjs`, template engines…) is
untouched. Confirmed: nothing telescope-shaped is imported.

### 3.2 Where the publish call goes

File: `/home/dudousxd/personal/nestjs-inertia/packages/core/src/service.ts`,
method `InertiaService.render()`.

Hook point A — **version mismatch** (after line 303, inside the `if` that does the
409): publish the minimal variant (§1.4) before `return`.

Hook point B — **main path** (after the `PageObject` is fully assembled, ~line 457,
after `page.matchPropsOn`/`encryptHistory`/`clearHistory` are set, and AFTER we
know the serialized JSON for the XHR branch). Publish the full event. Place it just
before the `if (this.req.header('X-Inertia'))` branch so both XHR and SSR paths
emit, and compute `pageBytes` from the serialized JSON we already produce for XHR.

Marker classification bookkeeping: the big `for` loop at `service.ts:347` already
branches on `kind === 'optional' | 'once' | 'defer' | 'merge'`. Add lightweight
`if (inertiaChannel.hasSubscribers)` pushes into local arrays inside those branches
(`optionalKeys.push(key)`, `onceKeys.push(key)`, and `excludedKeys.push(key)` at
each `continue` that drops a key). `deferredProps`, `mergeProps`, `deepMergeProps`,
`matchPropsOn` are *already* tracked — reuse them directly. `sharedKeys` =
`Object.keys(sharedProps)` from `resolveShared()` (already computed, line 321).

### 3.3 Config gate — recommend "always-publish, gated by subscribers"

Do **not** add a `diagnostics: true` module option as the primary gate. The
`hasSubscribers` check already gives zero-cost-when-off, and the gate that matters
(is anyone watching?) lives on the telescope side. Adding a producer flag would
force users to configure both ends.

Provide ONE optional escape hatch in `InertiaModuleOptions`
(`/home/dudousxd/personal/nestjs-inertia/packages/core/src/types.ts:73`):

```ts
interface InertiaModuleOptions {
  // …existing…
  /** Hard-disable diagnostics_channel publishing even when a subscriber exists.
   *  Default true. Set false to guarantee no publish in hardened prod. */
  diagnostics?: boolean;
}
```

Thread it through `InertiaServiceDeps` (`service.ts:203`) as `diagnostics?: boolean`,
assembled in `module.ts` (~line 421 alongside `historyEncryptionDefault`). The
publish becomes `if (this.deps.diagnostics !== false && inertiaChannel.hasSubscribers)`.
This is belt-and-suspenders for §7's prod opt-in; the common case needs no config.

### 3.4 Exports

`index.ts` exports `INERTIA_DIAG_CHANNEL` and the `InertiaRenderDiagnostic` type
(type-only, for anyone — including the telescope watcher author — who wants the
shape). Telescope still does not *import* it at runtime; it copies the structural
type to stay dependency-free.

---

## 4. nestjs-telescope watcher (consumer)

### 4.1 New package — mirror the per-integration package convention

Telescope ships integrations as sibling packages (`packages/events`, `redis-watcher`,
`bullmq`, …), each exporting a `Watcher`. Add `packages/inertia-watcher` with:

```
packages/inertia-watcher/src/
  index.ts                       // export { InertiaWatcher }, types
  inertia.watcher.ts             // the Watcher
  inertia-content.ts             // buildInertiaContent() + InertiaContent type + redaction shaping
  inertia.watcher.spec.ts
```

It depends on `@dudousxd/nestjs-telescope` (core) as a peer, exactly like
`redis-watcher`/`events` do.

### 4.2 The watcher — DC subscriber following the `Watcher` contract

Implements `Watcher` (`packages/core/src/nest/watcher.ts`). Unlike the
EventsWatcher (resolves EventEmitter2 from DI) or RedisWatcher (wraps a client), this
watcher subscribes to a diagnostics channel — but the *shape* (idempotent
`register()`, `cleanup()`, `safeRecord`, swallow-all-errors) matches EventsWatcher
1:1.

```ts
import diagnostics_channel from 'node:diagnostics_channel';
import { EntryType_Inertia, type Watcher, type WatcherContext, type RecordInput }
  from '@dudousxd/nestjs-telescope';

const INERTIA_CHANNEL = 'nestjs-inertia:render'; // hardcoded contract string

export class InertiaWatcher implements Watcher {
  readonly type = 'inertia';                  // new entry type string (see §4.4)
  private registered = false;
  private onMessage: ((msg: unknown) => void) | null = null;

  register(ctx: WatcherContext): void {
    if (this.registered) return;
    this.registered = true;
    const ch = diagnostics_channel.channel(INERTIA_CHANNEL);
    this.onMessage = (msg) => this.safeRecord(ctx, msg);
    ch.subscribe(this.onMessage);              // flips inertia's hasSubscribers -> true
  }

  cleanup(): void {
    if (this.onMessage) {
      diagnostics_channel.channel(INERTIA_CHANNEL).unsubscribe(this.onMessage);
      this.onMessage = null;
    }
  }

  private safeRecord(ctx: WatcherContext, msg: unknown): void {
    try {
      if (!isInertiaDiagnostic(msg)) return;   // defensive structural validation
      ctx.record(buildInertiaContent(msg));    // RecordInput; Recorder redacts/clips
    } catch { /* swallow — telescope must never break a render */ }
  }
}
```

Key correctness point: `diagnostics_channel` invokes subscribers **synchronously,
inside `publish()`**, i.e. on the same call stack / async context as
`InertiaService.render()`. So `ctx.record(...)` runs inside the request's ALS batch
(opened by Telescope's HTTP/request entry-point), and the entry auto-correlates —
no request id plumbing needed (§6).

### 4.3 Field → persisted content mapping

`buildInertiaContent(msg)` returns `RecordInput` (`entry.ts:56`):

```ts
function buildInertiaContent(d: InertiaRenderDiagnostic): RecordInput<InertiaContent> {
  const tags = ['inertia', `inertia:component:${d.component}`];
  if (d.isPartial)        tags.push('inertia:partial');
  if (d.versionMismatch)  tags.push('inertia:version-mismatch');
  if (Object.keys(d.props.deferred).length) tags.push('inertia:deferred');
  if (d.props.merge.length || d.props.deepMerge.length) tags.push('inertia:merge');
  return {
    type: 'inertia',
    familyHash: `inertia:${d.component}`,      // groups all renders of a component
    durationMs: null,                          // render time is the request entry's job
    startedAt: undefined,
    tags,
    content: {                                 // -> InertiaContent (redacted downstream)
      component: d.component,
      method: d.method,
      url: d.url,
      statusCode: d.statusCode,
      isPartial: d.isPartial,
      versionMismatch: d.versionMismatch,
      assetVersion: d.assetVersion,
      clientVersion: d.clientVersion,
      encryptHistory: d.encryptHistory,
      clearHistory: d.clearHistory,
      pageBytes: d.pageBytes,
      ssr: d.ssr,
      partial: d.partial,
      props: d.props,                          // keys + classification (small)
      resolvedProps: d.resolvedProps,          // THE heavy field — Recorder clips/masks
    },
  };
}
```

`InertiaContent` is added to the union conceptually alongside the existing content
types in `packages/core/src/entry/content.ts` (the watcher package owns it; core's
`content.ts` doc-comments these for builtins, the watcher mirrors the convention).

`familyHash = inertia:<component>` lets the dashboard group + count renders per page
component, mirroring `event:<name>` / `redis:<CMD>`.

### 4.4 Registering the new entry type for the dashboard nav

`EntryType` in `packages/core/src/entry/entry.ts` is the builtin map. Community
watchers use a plain `type` string (`'inertia'`) — they don't need to extend the
const. The registrar (`telescope-watcher-registrar.service.ts`) calls
`service.setWatchers([...registered])` using each watcher's `.type`, so `'inertia'`
flows into `/meta.watchers` automatically and the UI nav shows the tab (§5.4). No
core edit required for registration; the only core touch is optionally adding
`Inertia: 'inertia'` to the `EntryType` map for a typed constant (nice-to-have, not
required).

### 4.5 Install

Host adds the watcher like any other:
```ts
TelescopeModule.forRoot({ watchers: [ new InertiaWatcher() ] })
```
On `onApplicationBootstrap`, the registrar calls `register(ctx)`, which subscribes
to the channel → inertia's `hasSubscribers` becomes true → events start flowing.

---

## 5. The UI panel

Telescope UI is a React SPA at `packages/ui/src`, HashRouter routes in
`app/App.tsx`, generic list at `entries-table.tsx`, generic detail dispatch in
`react/components/entry-detail.tsx` (a `entry.type === '…' ? <XBody/> :` ladder),
nav in `app/dashboard-layout.tsx` driven by `visibleEntryTypes(ENTRY_TYPES, meta.watchers)`.

The Inertia panel rides the existing generic entries infrastructure — most work is a
new detail body component plus a nav/label entry.

### 5.1 List view

No new route needed for the list: `/entries/inertia` already works via the existing
`<Route path="/entries/:type" element={<EntriesPage />} />`. Add inertia formatting
to the shared list:

- `entries-table.tsx` `summaryText()` (the `if (entry.type === 'event' …)` ladder):
  add `if (entry.type === 'inertia' && record.component) return \`${record.method} → ${record.component}${record.isPartial ? ' (partial)' : ''}\`;`
- Columns shown by the generic table: type, summary, time. The summary above
  surfaces component + method + partial. Status (200/409) and size can be appended
  to the summary or shown as a small badge component (mirror `CacheBadge`):
  a new `InertiaBadge` showing `409` (red, version-mismatch), `partial`, `deferred`,
  `bytes`.

### 5.2 Detail view

Add `InertiaBody` to the `entry-detail.tsx` dispatch ladder:
`) : entry.type === 'inertia' ? ( <InertiaBody content={entry.content} /> )`.

`InertiaBody` (new file `react/components/inertia-body.tsx`) sections:

1. **Header line** — `method url → component`, status badge (200/409), `partial`
   badge, asset version chip. If `versionMismatch`, a prominent red callout:
   "Version mismatch: client `<clientVersion>` ≠ server `<assetVersion>` → 409
   forced full reload."
2. **Partial-reload panel** (only when `isPartial`) — two columns: **Kept** (`only`)
   and **Excluded** (`except` ∪ `excludedKeys`), plus `reset`/`resetOnce` chips.
   Answers "which keys came back this request?".
3. **Props classification** — chip rows: Shared (`sharedKeys`), Final (`finalKeys`),
   Optional (`optionalKeys`), Once (`onceKeys`), Merge (`merge`) / Deep-merge
   (`deepMerge`) with `matchPropsOn` annotations.
4. **Deferred groups** — `deferred` rendered as group → [dotPaths] (e.g.
   `default: [user.stats]`), so the dev sees what the client will lazy-fetch.
5. **Resolved props tree** — a collapsible JSON tree of `resolvedProps`. Reuse the
   existing JSON `<pre>` rendering used by `DumpBody`/`EventBody`
   (`prettyJson(...)`), or a lightweight collapsible tree. Truncation markers
   (`[Truncated: size]`, `…[truncated]`, `[REDACTED]`) from the Recorder show up
   verbatim — the dev sees exactly what was clipped/masked.
6. **History flags** — `encryptHistory` / `clearHistory` booleans as chips.
7. **Response** — `pageBytes` (human-readable), `ssr` yes/no.

Right-hand `<aside>` (shared by `EntryDetail`) already shows User, Trace, and
**Batch** — so the dev jumps from the Inertia entry to the sibling `request` entry
(the HTTP response) in the same batch. This IS the correlation UX (§6).

### 5.3 Components / files to add (UI)

- `packages/ui/src/react/components/inertia-body.tsx` — `InertiaBody`,
  `PartialReloadPanel`, `DeferredGroups`, `PropClassChips`, `ResolvedPropsTree`.
- `packages/ui/src/react/components/inertia-badge.tsx` — list/detail badge
  (mirrors `cache-badge.tsx`).
- Edit `entries-table.tsx` (`summaryText` + optional badge column).
- Edit `entry-detail.tsx` (one ladder branch).

### 5.4 Nav

`dashboard-layout.tsx` builds entry-type nav from `visibleEntryTypes(ENTRY_TYPES,
meta.watchers)`. Add `{ type: 'inertia', label: 'Inertia' }` to the UI's
`ENTRY_TYPES` list; it self-hides when the watcher isn't active because
`/meta.watchers` won't contain `'inertia'` (driven by §4.4). Add an icon to match
the other types.

---

## 6. Correlation with the HTTP request entry

**Mechanism: shared async context, zero plumbing.**

- Telescope opens an ALS batch per HTTP request (its request entry-point watcher;
  `WatcherContext.runInBatch('http', …)`), and `service.record()` enriches each entry
  with the active `batchId` + trace/span ids from `TelescopeContext`/`TraceContextProvider`
  (see `recorder.ts`, `entry.ts` `batchId`/`traceId`/`spanId`).
- `diagnostics_channel.publish()` calls subscribers **synchronously on the caller's
  stack**, so `InertiaService.render()` → `publish()` → `InertiaWatcher.safeRecord()`
  → `ctx.record()` all run inside that request's ALS scope.
- Result: the `inertia` entry lands in the **same batch** as the `request` entry for
  that HTTP call, with the same `traceId`/`spanId`. The detail view's Batch sidebar
  (`BatchTimeline`) and the `request` timeline already link them. **No request-id
  field is needed in the event payload.**

Same model the EventsWatcher and RedisWatcher rely on ("runs in the emitter's async
context, so the entry lands in the request/job batch" — `events.watcher.ts` doc).

Edge case: if inertia renders outside any Telescope batch (unlikely for HTTP), the
entry records with a standalone batch — acceptable, still visible.

---

## 7. Security / privacy

1. **Secret redaction is automatic.** `resolvedProps` passes through the Recorder's
   `redactBounded()` with `DEFAULT_REDACT_KEYS` (`password`, `token`, `secret`,
   `authorization`, `api_key`, `access_token`, `refresh_token`, …) masked to
   `[REDACTED]`. Hosts extend via `redact.keys` / `redact.paths`
   (e.g. `props.user.ssn`). No Inertia-specific redaction code needed.
2. **Payload size cap** — `DEFAULT_MAX_CONTENT_BYTES = 16_384`, depth 8, arrays 200,
   nodes 5_000, strings 8_192 (`redact.ts`). Large prop trees are clipped with
   visible markers; `truncatedCount` self-metric increments. The producer never
   stringifies props, so the cap actually applies.
3. **Production opt-in** — three independent gates, all default-safe:
   - Telescope itself is dev-first; if the `InertiaWatcher` isn't in `watchers`,
     `hasSubscribers` stays false and inertia publishes nothing.
   - Per-type `sampling` can throttle `inertia` entries in prod.
   - inertia's `diagnostics: false` hard-kills publishing regardless of subscribers
     (§3.3) for hardened deployments.
4. **No new attack surface on the producer** — `diagnostics_channel` is in-process;
   nothing is exposed over the network by inertia. Telescope's existing auth gates
   the dashboard.
5. **Untrusted shape** — the watcher structurally validates the message
   (`isInertiaDiagnostic`) and version (`v === 1`) before recording; malformed/old
   payloads are dropped, never thrown.

---

## 8. Implementation phases

**Phase A — emit events from inertia** (`nestjs-inertia`)
- Add `INERTIA_DIAG_CHANNEL` const + channel singleton in `service.ts`.
- Add classification bookkeeping (guarded by `hasSubscribers`) in the render loop.
- Publish full event at hook B; minimal event at the 409 hook A.
- Add `diagnostics?: boolean` to `InertiaModuleOptions` + thread through
  `InertiaServiceDeps` + `module.ts`.
- Export const + `InertiaRenderDiagnostic` type from `index.ts`.
- Ships independently; no telescope dependency; no-op when unsubscribed.

**Phase B — telescope watcher + storage** (`nestjs-telescope`)
- New `packages/inertia-watcher` package (mirror `redis-watcher`).
- `InertiaWatcher` (DC subscribe/unsubscribe, `safeRecord`), `buildInertiaContent`,
  `InertiaContent` type, structural validator.
- Optional: add `Inertia: 'inertia'` to core `EntryType`.
- Verify auto-correlation into the request batch.

**Phase C — UI panel** (`packages/ui`)
- `inertia-body.tsx` (+ sub-components), `inertia-badge.tsx`.
- Wire `entry-detail.tsx` ladder + `entries-table.tsx` summary.
- Add `'inertia'` to `ENTRY_TYPES` + nav icon/label.

Phases are independently shippable: A alone costs ~zero and is safe to release; B
makes data appear under the generic entries view; C adds the rich panel.

---

## 9. Testing

**Phase A (inertia)**
- `service.spec.ts`: subscribe a fake listener to `nestjs-inertia:render`; assert
  exactly one event per `render()`, with correct `component`, `deferred`, `partial`
  (only/except), `optionalKeys`/`onceKeys`, `mergeProps`, `encryptHistory`,
  `versionMismatch` (force the 409 branch), `pageBytes`.
- Zero-cost test: with NO subscriber, spy that `buildDiagnostic`/classification code
  is never invoked (`hasSubscribers === false`); assert no extra allocations / the
  guard short-circuits.
- `diagnostics: false` suppresses publish even with a subscriber.
- Partial-reload test: send `X-Inertia-Partial-Data`/`-Except`; assert kept/excluded
  keys match the resolved page.

**Phase B (watcher)**
- Mirror `events.watcher.spec.ts` / `redis-command.watcher.spec.ts`: `register(ctx)`
  subscribes (channel `hasSubscribers` true); publishing a fake diagnostic calls
  `ctx.record` once with mapped `content`/`tags`/`familyHash`; `cleanup()`
  unsubscribes (`hasSubscribers` false again).
- Idempotent `register()` (double-register subscribes once).
- Malformed / wrong-`v` payloads are dropped, never throw.
- Redaction integration: a `resolvedProps` with `password` / oversized tree comes
  out masked/clipped after the Recorder (assert `[REDACTED]` / truncation markers,
  `truncatedCount` bumped).
- Correlation: record inside a `runInBatch('http', …)` scope, assert the entry's
  `batchId` matches the surrounding request batch.

**Phase C (UI)**
- `inertia-body.spec.tsx` (mirror `entry-detail.spec.tsx`): renders component,
  partial kept/excluded columns, deferred groups, version-mismatch callout, resolved
  props tree, history flags.
- `entries-table` summary renders `METHOD → Component (partial)`.
- Nav: `'inertia'` tab visible only when `meta.watchers` includes it.

---

## 10. Key real symbols referenced

Producer (`nestjs-inertia`):
- `/home/dudousxd/personal/nestjs-inertia/packages/core/src/service.ts` —
  `InertiaService.render()`; 409 short-circuit (L294–303); marker loop (L347–440);
  `PageObject` assembly (L448–464); XHR `.json(page)` (L466–468).
- `.../core/src/types.ts:73` `InertiaModuleOptions`; `service.ts:203`
  `InertiaServiceDeps`; `module.ts:~421` deps assembly.
- `.../core/src/markers.ts` — `optional`/`once`/`defer`/`merge`/`always` kinds.

Consumer (`nestjs-telescope`):
- `packages/core/src/nest/watcher.ts` — `Watcher` / `WatcherContext` / `record`.
- `packages/events/src/events.watcher.ts` — template for the new watcher.
- `packages/redis-watcher/src/redis-command.watcher.ts` — sibling-package + cleanup
  template.
- `packages/core/src/entry/entry.ts` — `EntryType`, `RecordInput`, `Entry`
  (`batchId`/`traceId`).
- `packages/core/src/entry/content.ts` — content-type convention.
- `packages/core/src/redaction/redact.ts` — `redactBounded`, default bounds + keys.
- `packages/core/src/recorder/recorder.ts` — enrichment, `truncatedCount`.
- `packages/core/src/nest/telescope-watcher-registrar.service.ts` — `setWatchers`.
- `packages/ui/src/react/components/entry-detail.tsx` (dispatch ladder),
  `entries-table.tsx` (`summaryText`), `cache-badge.tsx` (badge pattern),
  `app/dashboard-layout.tsx` (`visibleEntryTypes`), `app/App.tsx` (routes).
