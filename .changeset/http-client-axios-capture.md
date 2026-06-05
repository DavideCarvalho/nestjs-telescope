---
"@dudousxd/nestjs-telescope": minor
---

`HttpClientWatcher` can now capture outbound axios / `@nestjs/axios` calls, not just the global `fetch`. In Node axios uses the http adapter (not `fetch`), so `HttpService` traffic was previously invisible. Pass an `axios` source to the watcher to capture it via axios's public interceptor API — no monkey-patching: either a bare axios instance (`new HttpClientWatcher({ axios: client })`) or a custom source (`{ instrument(attach, ctx) }`) that resolves `HttpService` from `ctx.moduleRef` and hands over `axiosRef` lazily at register time. Axios entries share the same content shape, tags, and family-hash as fetch entries, so the two are indistinguishable downstream. Request timing is tracked with a `WeakMap` keyed by the axios config object (no mutation of host objects); rejections record `error.response?.status ?? null` and are always re-thrown; instrumentation is idempotent per axios instance.
