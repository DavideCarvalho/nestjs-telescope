---
'@dudousxd/nestjs-telescope-ui': minor
---

**Headless console launcher: `openTelescopeConsole` / `mintTelescopeConsoleSession` / `telescopeConsoleSessionUrl`, exported from `@dudousxd/nestjs-telescope-ui/client`.**

The console is entered from the HOST's app: a browser navigation to it carries no identity, so
something inside the host has to mint the Mode A session cookie first (an XHR that *does* carry the
host's auth), then navigate. Every host was writing that by hand, which meant hardcoding two things
this package owns:

- **the session endpoint's path** — ``<path>/api/auth/session``. Nothing tells a host when that moves; the break
  only shows up as a runtime 404 after a version bump.
- **`redirect: 'manual'`** — and this one is a real trap. `fetch` follows redirects by default, so a
  host whose auth layer rewrites a 401 into a sign-in redirect gets a resolved 200 against the
  sign-in HTML. `response.ok` reads true, the caller navigates, and the user lands in a console with
  no session — indistinguishable from a permissions bug. The helper detects the redirect (browser
  opaque response *and* Node/undici 3xx) and throws a message naming the likely cause.

```ts
import { openTelescopeConsole } from '@dudousxd/nestjs-telescope-ui/client';

await openTelescopeConsole({ headers: () => ({ Authorization: `Bearer ${token()}` }) });
```

No UI: the host owns the button, the page and the copy. `headers` accepts a sync or async function
so a refreshing token is read at call time rather than captured at wiring time. `fetch` and
`navigate` are injectable (tests, routers, non-browser callers). A refused mint throws
`ConsoleSessionError` (carrying `status` and `url`) and **does not navigate** — a denied user gets a
real error instead of the console's "no session" page.

Additive only: nothing existing changes.
