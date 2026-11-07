# @dudousxd/nestjs-telescope-official

Telescope for NestJS's first-party packages. It records what they already publish and builds
nothing they already do:

- **Channel watchers**: the `node:diagnostics_channel` events of `@nestjs/resilience` (9
  channels), `@nestjs/workflows` (19), `@nestjs/authentication` (13), `@nestjs/authorization`
  (`denied`) and `@nestjs/mail` (`sent`, `failed`), as `resilience`, `workflow`, `auth` and `mail`
  entries with dashboard cards.
- **`telescopeAiUsage()`**: an `onUsage` listener for `@nestjs/ai` that feeds Telescope's AI screen
  and AI metrics.
- **`ObserveTraceContextProvider`**: Telescope's `traceContext` from `@nestjs/observe`'s trace id.

Nothing here imports the official packages at runtime (all are optional peers), and every payload
is read structurally.

```sh
pnpm add @dudousxd/nestjs-telescope-official
```

## Channel watchers

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { officialWatchers } from '@dudousxd/nestjs-telescope-official';

TelescopeModule.forRoot({ storage, watchers: [...officialWatchers()] });
// officialWatchers({ mail: false, auth: { authorization: false } }) to turn pieces off
```

The payloads carry no trace id. A channel calls its subscribers synchronously in the publisher's
async context, so each entry lands in the request or job batch that emitted it, carrying the
current trace. Watchers unsubscribe when the app shuts down.

Auth entries are **redacted**:
- Only known fields are copied.
- `sessionId` and `tokenFamilyId` become SHA-256 fingerprints (`sessionRef`, `tokenFamilyRef`).
- Emails are masked.
- Session `metadata` keeps only its key names.
- A denial keeps the user's id and the argument count, never the user object or the records.

## `@nestjs/ai` usage

```ts
import { telescopeAiUsage } from '@dudousxd/nestjs-telescope-official';

AiModule.forRoot({ models, onUsage: telescopeAiUsage() });

// Keeping an existing onUsage:
const toTelescope = telescopeAiUsage();
AiModule.forRoot({ models, onUsage: (e) => { toTelescope(e); return myOnUsage(e); } });
```

Each model call becomes a `usage.recorded` `agent` entry: feature = `label`, cached input =
`cacheReadTokens`, cost = `costSource: 'estimate'`. The call is also counted in the AI metrics.
Attach it in one place only: `@nestjs/ai` runs the module's `onUsage` and then the call's.
Options: `feature`, `actor` (default `'@platform'`), `toUsd` (`cost` is in your `pricing` unit),
`record`, `metrics`.

## `@nestjs/observe` trace ids

```ts
TelescopeModule.forRootAsync({
  inject: [TracerService],
  useFactory: (tracer: TracerService) => ({ storage, traceContext: new ObserveTraceContextProvider(tracer) }),
});
```

This reads `TracerService.currentTraceId()`, turns the UUID into 32 hex digits, and adds a
synthetic span id. It reads **only** the trace id. `@nestjs/observe` after 0.3.20 is under the
NestJS Observe Agent License: its telemetry may go only to observe.nestjs.com, and it may not be
used to build a backend that receives that telemetry. Telescope never ingests Observe's spans or
metrics. The license states that passing trace context is allowed: *"Passing trace context, such
as traceparent or x-request-id headers, between Your applications and the services they call does
not violate (a) or (b)."*

Docs: [davidecarvalho.github.io/aviary/docs/telescope](https://davidecarvalho.github.io/aviary/docs/telescope) ·
NestJS packages: [docs.nestjs.com](https://docs.nestjs.com)
