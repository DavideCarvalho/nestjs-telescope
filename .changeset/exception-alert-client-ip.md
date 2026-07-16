---
'@dudousxd/nestjs-telescope': minor
---

Richer exception alerts + a new `every-exception` rule.

**Client IP + geo.** `new-exception`/`every-exception` alerts now carry the originating **client IP** — `request.ip` (first `x-forwarded-for` hop) for a server exception, and the server-filled `clientIp` for a browser-reported `client_exception` (never sourced from an untrusted body). It was already stored on the entry but dropped when the alert context was built. A new optional `alerts.geoLookup` hook resolves that IP to a coarse `{ city?, region?, country?, countryCode? }` location, rendered as a **Location** field — the lib ships no geo database, so the host owns the lookup and its caching.

**More context on the card.** The alert now surfaces the request **`referer`** and, for server exceptions, the **user-agent** (previously only present for client exceptions), plus the React **`componentStack`** and free-form **`extra`** bag for browser-reported errors that carry them. All are additive fields on `ExceptionAlertContext` and additive blocks in the Slack formatter.

**New `every-exception` rule.** Fires for **every** exception (server + `client_exception`), not just brand-new families — parity with a "notify on every error" setup. Still rate-limited by the shared `cooldown` per family (independent clock from `new-exception`); set `cooldown: '0s'` for a fully uncollapsed stream. Its optional `window` counts occurrences shown on the alert (default `1h`) and does not gate firing.

Fully backward compatible: every existing `AlertPayload`/`ExceptionAlertContext` field is unchanged; the new fields and rule are purely additive.
