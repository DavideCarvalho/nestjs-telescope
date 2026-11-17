---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-official': minor
---

Relay entries for other apps, tag events with their app, and find the control plane lazily.

- Relay: a token with `telescope:ingest:relay` (every app), `telescope:ingest:relay:<app>` (that app) or `telescope:*` may send entries tagged `app:<name>`; the control plane stores them as that app, tagged `via:<sender>`, deduped under the relayer and the app, never overwriting an entry it holds. Without the capability (including a token with no capabilities) nothing changes: the app is always the token's. Refused relays are counted per entry (`rejected`, logged); the ingest answer adds `relayed`/`rejected` only when a batch relayed. `via:` tags from senders are dropped. A tenant with `relay: true` tags its own entries `app:<partition>` (on the wire and in `local`) and sends relayed ones as they are.
- Official channel watchers tag an entry `app:<name>` from the `app` of a diagnostics envelope, else from the payload's `app` (read structurally; no diagnostics version required).
- `tenant.url` and `transports.http({ url })` accept a function (with an optional `refresh()`), called on the first send rather than at boot; a failed lookup keeps the entries buffered, and a send that cannot connect or gets a 404 looks the URL up again and resends once if it moved. Service discovery shares the lookup.
