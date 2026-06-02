---
'@dudousxd/nestjs-telescope': minor
---

Add `HttpClientWatcher`, a built-in watcher that instruments the global `fetch`
to capture outbound HTTP calls (method, URL, host, status, duration) correlated
to the request/job that made them. No peer dependency — it uses Node's built-in
`fetch`. Captured URLs have credentials and sensitive query params redacted. Adds
the `http_client` entry type and `HttpClientContent`.
