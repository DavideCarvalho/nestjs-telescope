---
"@dudousxd/nestjs-telescope": minor
---

Add a pre-record request-body capture gate, `requestCapture` on
`TelescopeModuleOptions`, plus a typed `TelescopeHttpRequest` for hook
signatures that previously took `request: unknown`.

**`requestCapture`**: `TelescopeRequestMiddleware` used to hand the raw,
already-decoded request body straight to `TelescopeService.record()`, so a
multi-MB JSON/string body always paid for the recorder's synchronous
redaction walk before its bounds could kick in. `requestCapture` gates the
body BEFORE `record()` ever sees it — the walk never runs over a skipped
body:

- `maxBodyBytes` (default `131_072`, 128 KiB): size from the `content-length`
  header when present, else a string/Buffer body's own length. A parsed
  object body without `content-length` is never measured (no
  `JSON.stringify` — that would be the walk this gate avoids) and passes the
  size gate untouched. Set `false` to disable.
- `skipBodyContentTypes` (default: `application/offset+octet-stream`,
  `application/octet-stream`, `multipart/form-data`): string-prefix or
  `RegExp` match against the `content-type` header.
- `skipBody(request)`: an escape hatch for route-based skips (e.g. a tus
  resumable-upload endpoint), checked in addition to the two gates above.

Every gate is ON by default (the 128 KiB cap + the binary content-type
list) — this is a safe-by-default fix, not an opt-in. When a gate trips, the
request entry is still recorded in full (method/path/status/duration/user/
headers); only `payload` becomes a marker string (`'[Skipped: N bytes >
maxBodyBytes]'`, `'[Skipped: <content-type>]'`, or `'[Skipped: skipBody
predicate]'`).

**Typed hooks**: `clientErrors.authorize` and `dashboardAuth.session` (the
`SessionHook` type) now receive a `TelescopeHttpRequest` — a minimal
structural type (`method`, `url`, `headers`, `user`, plus an index
signature) — instead of `unknown`. Hosts can read `request.headers` /
`request.user` directly with no hand-rolled type guard; a real Express or
Fastify request satisfies the shape as-is. `toTelescopeHttpRequest()` is
exported from core for anyone narrowing a raw platform request themselves.
