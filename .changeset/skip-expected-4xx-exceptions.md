---
'@dudousxd/nestjs-telescope': minor
---

Skip expected 4xx `HttpException`s by default — they're control flow, not incidents.

The server exception interceptor no longer records a NestJS `HttpException` whose status is a 4xx (`>= 400 && < 500`) as an `exception` entry. A `403 ForbiddenException`, a `404 NotFoundException`, or a `400` from the validation pipe is the framework doing its job — permission denied, resource missing, bad input — not an incident.

**Why this changed (a real incident):** Telescope's own client-errors `authorize` gate threw a 403, the interceptor captured it as a brand-**new** exception family (the family hash keys on class + message + top frame, so each call site is distinct), which fired the `new-exception` Slack alert and, in AI auto-mode, burned a model diagnosis on intended behaviour. In production every permission denial would page on-call and spend tokens.

**Nothing is lost.** The request watcher still records the 4xx `statusCode` on its own `request` entry (independently), so the 4xx is still visible in the dashboard and in error-rate metrics — it just no longer opens an exception family, fires `new-exception`, or triggers AI diagnosis. Because the `new-exception` alert and AI auto-diagnosis both consume `exception` entries off the flush path, filtering at capture covers them with no separate change.

**Always recorded:** 5xx `HttpException`s (real server errors) and any non-`HttpException` error. **Untouched:** browser-reported `client_exception` entries (recorded directly by the ingestion endpoint, never through this interceptor).

**Escape hatch:** set `exceptions: { captureHttp4xx: true }` (new option, default `false`) to restore the pre-change behaviour and capture 4xx `HttpException`s as exceptions again.
